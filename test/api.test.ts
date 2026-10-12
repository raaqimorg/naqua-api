import assert from 'node:assert/strict';
import { Option } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { describe, test } from 'node:test';
import { clientKey, slidingWindow } from '../src/http/rateLimit.ts';
import { AMBIGUOUS_TICKER, app, calculate, dataset, disputedApp, get, json, makeTestApp } from './helpers.ts';

describe('GET /v1/companies', () => {
  test('lists every resolved company once, sorted by ticker', async () => {
    const response = await get('/v1/companies');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
    assert.equal(response.headers.get('X-Data-Version'), dataset.version);

    const body = await json(response);
    assert.equal(body.count, dataset.companies.length);
    const tickers = body.companies.map((company: { ticker: number }) => company.ticker);
    assert.deepEqual(tickers, [...tickers].sort((a, b) => a - b));
    assert.equal(new Set(tickers).size, tickers.length);
    for (const unresolved of dataset.unresolved) assert.ok(!tickers.includes(unresolved.ticker));
  });

  test('summarises each company', async () => {
    const body = await json(await get('/v1/companies'));
    const advanced = body.companies.find((company: { ticker: number }) => company.ticker === 2330);
    assert.deepEqual(advanced, {
      ticker: 2330,
      name: 'المتقدمة',
      aliases: [],
      overallStatus: 'varies',
      availableYears: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
    });
  });
});

describe('GET /v1/companies/:ticker', () => {
  test('returns every known year', async () => {
    const response = await get('/v1/companies/2330');
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.name, 'المتقدمة');
    assert.deepEqual(body.years[0], { year: 2015, ratePerShare: 0.0199, status: 'mixed' });
  });

  test('includes a year that has a status but no rate', async () => {
    const body = await json(await get('/v1/companies/4011'));
    assert.deepEqual(body.years.find((year: { year: number }) => year.year === 2015), {
      year: 2015,
      ratePerShare: null,
      status: 'non-pure',
    });
  });

  test('carries former names as aliases', async () => {
    const body = await json(await get('/v1/companies/4240'));
    assert.equal(body.name, 'سينومي ريتيل');
    assert.deepEqual(body.aliases, ['فواز الحكير']);
  });

  test('calls Aramco public-sector', async () => {
    const body = await json(await get('/v1/companies/2222'));
    assert.equal(body.overallStatus, 'public-sector');
  });

  test('404s an unknown ticker with a bilingual message', async () => {
    const response = await get('/v1/companies/9999');
    assert.equal(response.status, 404);
    const { error } = await json(response);
    assert.equal(error.code, 'UNKNOWN_TICKER');
    assert.match(error.message.ar, /9999/);
    assert.match(error.message.en, /9999/);
  });

  test('409s a ticker the data assigns to two different companies', async () => {
    for (const path of [`/v1/companies/${AMBIGUOUS_TICKER}`, `/v1/companies/${AMBIGUOUS_TICKER}/rates/2024`]) {
      const response = await disputedApp.request(path);
      assert.equal(response.status, 409, path);
      const { error } = await json(response);
      assert.equal(error.code, 'AMBIGUOUS_TICKER');
      assert.deepEqual(error.details.candidates, ['أ', 'ب']);
    }
  });

  test('400s a non-numeric ticker', async () => {
    const response = await get('/v1/companies/abc');
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /v1/companies/:ticker/rates/:year', () => {
  test('returns one year', async () => {
    const response = await get('/v1/companies/2330/rates/2023');
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      ticker: 2330,
      name: 'المتقدمة',
      year: 2023,
      ratePerShare: 0.0203,
      status: 'pure',
    });
  });

  test('404s a year outside the data', async () => {
    const response = await get('/v1/companies/2330/rates/2031');
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, 'RATE_NOT_AVAILABLE');
  });

  test('404s a year with a status but no rate', async () => {
    const response = await get('/v1/companies/4011/rates/2015');
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, 'RATE_NOT_AVAILABLE');
  });
});

describe('POST /v1/purification/calculate', () => {
  test('prorates a date range across calendar years', async () => {
    const response = await calculate({
      entries: [{ ticker: 2330, shares: 100, purchaseDate: '2021-03-01', saleDate: '2023-06-30' }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      currency: 'SAR',
      totalPurificationAmount: 4.9808219178,
      entries: [
        {
          index: 0,
          ticker: 2330,
          companyName: 'المتقدمة',
          shares: 100,
          purificationAmount: 4.9808219178,
          years: [
            { year: 2021, daysOwned: 306, ratePerShare: 0.026, status: 'pure', purificationAmount: 2.1797260274 },
            { year: 2022, daysOwned: 365, ratePerShare: 0.018, status: 'pure', purificationAmount: 1.8 },
            { year: 2023, daysOwned: 180, ratePerShare: 0.0203, status: 'pure', purificationAmount: 1.0010958904 },
          ],
        },
      ],
    });
  });

  test('accepts days mode and still-owned holdings in one request', async () => {
    const response = await calculate({
      entries: [
        { ticker: 2001, shares: 50, year: 2022, daysOwned: 200 },
        { ticker: 2222, shares: 10, purchaseDate: '2023-01-01', stillOwned: true },
      ],
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.entries.map((entry: { index: number }) => entry.index), [0, 1]);
    const aramcoYears = body.entries[1].years.map((year: { year: number; daysOwned: number }) => [year.year, year.daysOwned]);
    assert.deepEqual(aramcoYears, [
      [2023, 365],
      [2024, 365],
    ]);
    const entryTotal = body.entries.reduce((sum: number, entry: { purificationAmount: number }) => sum + entry.purificationAmount, 0);
    assert.equal(body.totalPurificationAmount, Number(entryTotal.toFixed(10)));
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ['both modes', { ticker: 2330, shares: 1, purchaseDate: '2020-01-01', saleDate: '2021-01-01', year: 2020, daysOwned: 5 }, 'year'],
    ['neither mode', { ticker: 2330, shares: 1 }, 'purchaseDate'],
    ['a sale date without a purchase date', { ticker: 2330, shares: 1, saleDate: '2021-03-01' }, 'purchaseDate'],
    ['an impossible date', { ticker: 2330, shares: 1, purchaseDate: '2021-02-30', saleDate: '2021-03-01' }, 'purchaseDate'],
    ['a date before the data', { ticker: 2330, shares: 1, purchaseDate: '2014-12-31', saleDate: '2015-03-01' }, 'purchaseDate'],
    ['a sale after the data', { ticker: 2330, shares: 1, purchaseDate: '2024-01-01', saleDate: '2025-01-01' }, 'saleDate'],
    ['a sale on the purchase day', { ticker: 2330, shares: 1, purchaseDate: '2021-05-01', saleDate: '2021-05-01' }, 'saleDate'],
    ['a missing sale date', { ticker: 2330, shares: 1, purchaseDate: '2021-05-01' }, 'saleDate'],
    ['a sale date on a still-owned holding', { ticker: 2330, shares: 1, purchaseDate: '2021-05-01', saleDate: '2022-01-01', stillOwned: true }, 'saleDate'],
    ['still owned from the last day of the data', { ticker: 2330, shares: 1, purchaseDate: '2024-12-31', stillOwned: true }, 'purchaseDate'],
    ['a year outside the data', { ticker: 2330, shares: 1, year: 2014, daysOwned: 10 }, 'year'],
    ['days past the data', { ticker: 2330, shares: 1, year: 2024, daysOwned: 366 }, 'daysOwned'],
    ['days without a year', { ticker: 2330, shares: 1, daysOwned: 10 }, 'year'],
    ['fractional days', { ticker: 2330, shares: 1, year: 2024, daysOwned: 1.5 }, 'daysOwned'],
    ['zero shares', { ticker: 2330, shares: 0, year: 2024, daysOwned: 10 }, 'shares'],
    ['a ticker as a string', { ticker: '2330', shares: 1, year: 2024, daysOwned: 10 }, 'ticker'],
  ];
  for (const [label, entry, field] of invalid) {
    test(`rejects ${label}`, async () => {
      const response = await calculate({ entries: [entry] });
      assert.equal(response.status, 400);
      const { error } = await json(response);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(
        error.details.some((issue: { path: string }) => issue.path === `entries.0.${field}`),
        `expected an issue on entries.0.${field}, got ${JSON.stringify(error.details)}`,
      );
    });
  }

  test('explains its own rules in its own words', async () => {
    const issue = async (entry: Record<string, unknown>) => (await json(await calculate({ entries: [entry] }))).error.details[0];
    assert.deepEqual(await issue({ ticker: 2330, shares: 1, year: 2024, daysOwned: 366 }), {
      path: 'entries.0.daysOwned',
      message: 'Starting in 2024, `daysOwned` cannot exceed 365 (data ends in 2024).',
    });
    assert.deepEqual(await issue({ ticker: 2330, shares: 1, purchaseDate: '2021-05-01', saleDate: '2021-05-01' }), {
      path: 'entries.0.saleDate',
      message: 'The sale date must be after the purchase date.',
    });
  });

  test('rejects an empty or oversized batch', async () => {
    assert.equal((await calculate({ entries: [] })).status, 400);
    const tooMany = Array.from({ length: 101 }, () => ({ ticker: 2330, shares: 1, year: 2024, daysOwned: 1 }));
    assert.equal((await calculate({ entries: tooMany })).status, 400);
  });

  // A body under 100 KB fits tens of thousands of entries; each used to be
  // validated and every issue listed, a response of megabytes.
  test('rejects an oversized batch without checking each entry', async () => {
    const response = await calculate({ entries: Array.from({ length: 30_000 }, () => ({})) });
    assert.equal(response.status, 400);
    const { error } = await json(response);
    assert.equal(error.details.length, 1);
    assert.deepEqual(error.details[0], { path: 'entries', message: 'A request can have at most 100 entries.' });
  });

  test('lists at most 20 issues', async () => {
    const response = await calculate({ entries: Array.from({ length: 100 }, () => ({ ticker: 'x', shares: 'y' })) });
    assert.equal(response.status, 400);
    const { error } = await json(response);
    assert.equal(error.details.length, 20);
    assert.equal(error.details[0].path, 'entries.0.ticker');
  });

  test('checks the body size and type before counting entries', async () => {
    const entries = Array.from({ length: 101 }, () => ({}));
    const asText = await app.request('/v1/purification/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ entries }),
    });
    assert.equal((await json(asText)).error.details, undefined);
    const tooLarge = await calculate({ entries, padding: 'x'.repeat(101 * 1024) });
    assert.equal(tooLarge.status, 413);
  });

  test('400s a body that is not JSON', async () => {
    const response = await calculate('not json');
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, 'VALIDATION_ERROR');
  });

  test('413s a body over 100 KB', async () => {
    const response = await calculate({ entries: [], padding: 'x'.repeat(101 * 1024) });
    assert.equal(response.status, 413);
    assert.equal((await json(response)).error.code, 'PAYLOAD_TOO_LARGE');
  });

  test('names the failing entry when a year has no rate', async () => {
    const response = await calculate({
      entries: [
        { ticker: 2330, shares: 1, year: 2024, daysOwned: 10 },
        { ticker: 2222, shares: 1, year: 2015, daysOwned: 10 },
      ],
    });
    assert.equal(response.status, 422);
    const { error } = await json(response);
    assert.equal(error.code, 'RATE_NOT_AVAILABLE');
    assert.deepEqual(error.details, { ticker: 2222, year: 2015, entryIndex: 1 });
  });

  test('404s an unknown ticker and names the entry', async () => {
    const response = await calculate({ entries: [{ ticker: 9999, shares: 1, year: 2024, daysOwned: 10 }] });
    assert.equal(response.status, 404);
    assert.deepEqual((await json(response)).error.details, { ticker: 9999, entryIndex: 0 });
  });

  test('refuses an ambiguous ticker instead of guessing', async () => {
    const response = await disputedApp.request('/v1/purification/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ ticker: AMBIGUOUS_TICKER, shares: 1, year: 2024, daysOwned: 10 }] }),
    });
    assert.equal(response.status, 409);
    const { error } = await json(response);
    assert.equal(error.code, 'AMBIGUOUS_TICKER');
    assert.equal(error.details.entryIndex, 0);
  });
});

describe('GET /v1/meta', () => {
  test('describes the data', async () => {
    const body = await json(await get('/v1/meta'));
    assert.equal(body.dataVersion, dataset.version);
    assert.deepEqual(body.coverage, {
      start: '2015-01-01',
      end: '2024-12-31',
      years: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
    });
    assert.equal(body.companyCount, dataset.companies.length);
    assert.deepEqual(body.unresolvedTickers, []);
    assert.deepEqual((await json(await disputedApp.request('/v1/meta'))).unresolvedTickers, [AMBIGUOUS_TICKER]);
    assert.equal(body.rateLimit.requestsPerMinute, 1_000_000);
  });
});

describe('rate limiting', () => {
  test('429s past the limit, per client, with Retry-After', async () => {
    let now = 0;
    const limited = makeTestApp({ dataset, requestsPerMinute: 2, isRender: true, now: () => now });
    const fromClient = (ip: string) => limited.request('/v1/meta', { headers: { 'CF-Connecting-IP': ip } });

    assert.equal((await fromClient('1.1.1.1')).status, 200);
    assert.equal((await fromClient('1.1.1.1')).headers.get('RateLimit-Remaining'), '0');

    const blocked = await fromClient('1.1.1.1');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');
    assert.equal((await json(blocked)).error.code, 'RATE_LIMITED');

    assert.equal((await fromClient('2.2.2.2')).status, 200);
    assert.equal((await fromClient('2001:db8::1')).status, 200);

    now = 60_000;
    assert.equal((await fromClient('1.1.1.1')).status, 200);
  });

  test('changing untrusted headers cannot refresh a Render client quota', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, isRender: true, now: () => 0 });
    const trusted = { 'CF-Connecting-IP': '198.51.100.1' };
    assert.equal((await limited.request('/v1/meta', { headers: trusted })).status, 200);

    for (const headers of [
      { 'X-Forwarded-For': '198.51.100.2' },
      { 'X-Forwarded-For': '198.51.100.3, 10.0.0.1' },
      { 'True-Client-IP': '198.51.100.4' },
      { 'X-Real-IP': '198.51.100.5' },
      { Forwarded: 'for=198.51.100.6' },
    ]) {
      const response = await limited.request('/v1/meta', { headers: { ...headers, ...trusted } });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('RateLimit-Remaining'), '0');
    }
  });

  test('missing or invalid Render client IPs never fall back to X-Forwarded-For', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, isRender: true, now: () => 0 });
    assert.equal((await limited.request('/v1/meta')).status, 200);

    const invalid = [undefined, '', 'made-up', '198.51.100.1, 198.51.100.2', '198.51.100.1:1234',
      '[2001:db8::1]', 'fe80::1%eth0', `fe80::1%${'x'.repeat(8 * 1024)}`];
    for (const [index, ip] of invalid.entries()) {
      const headers: Record<string, string> = { 'X-Forwarded-For': `198.51.100.${index + 1}` };
      if (ip !== undefined) headers['CF-Connecting-IP'] = ip;
      assert.equal((await limited.request('/v1/meta', { headers })).status, 429);
    }
  });

  test('forwarding headers are ignored outside Render', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, now: () => 0 });
    assert.equal((await limited.request('/v1/meta')).status, 200);

    for (const ip of ['198.51.100.1', '198.51.100.2', '2001:db8::1']) {
      const response = await limited.request('/v1/meta', {
        headers: { 'X-Forwarded-For': ip, 'CF-Connecting-IP': ip, 'True-Client-IP': ip, 'X-Real-IP': ip },
      });
      assert.equal(response.status, 429);
    }
  });

  test('an origin secret stops a forged CF-Connecting-IP from refreshing quota', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, isRender: true, originSecret: 'edge-secret', now: () => 0 });

    // No secret header: the request did not come through the edge, so every
    // CF-Connecting-IP collapses to the socket key and cannot refresh the quota.
    assert.equal((await limited.request('/v1/meta', { headers: { 'CF-Connecting-IP': '203.0.113.1' } })).status, 200);
    assert.equal((await limited.request('/v1/meta', { headers: { 'CF-Connecting-IP': '203.0.113.2' } })).status, 429);
    assert.equal((await limited.request('/v1/meta', { headers: { 'CF-Connecting-IP': '203.0.113.3', 'X-Naqua-Origin-Secret': 'wrong' } })).status, 429);
  });

  test('an origin secret still lets the edge key distinct clients', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, isRender: true, originSecret: 'edge-secret', now: () => 0 });
    const viaEdge = (ip: string) =>
      limited.request('/v1/meta', { headers: { 'CF-Connecting-IP': ip, 'X-Naqua-Origin-Secret': 'edge-secret' } });

    assert.equal((await viaEdge('203.0.113.1')).status, 200);
    assert.equal((await viaEdge('203.0.113.1')).status, 429);
    assert.equal((await viaEdge('203.0.113.2')).status, 200);
  });

  test('socket fallback preserves distinct directly connected clients', () => {
    const headers = { 'CF-Connecting-IP': '198.51.100.99', 'X-Forwarded-For': '198.51.100.98' };
    for (const ip of ['192.0.2.1', '192.0.2.2', '2001:db8::1']) {
      const request = HttpServerRequest.fromWeb(new Request('http://localhost/v1/meta', { headers }))
        .modify({ remoteAddress: Option.some(ip) });
      assert.equal(clientKey(request, false), ip);

      const withoutTrustedHeader = HttpServerRequest.fromWeb(new Request('http://localhost/v1/meta', {
        headers: { 'X-Forwarded-For': '198.51.100.98' },
      })).modify({ remoteAddress: Option.some(ip) });
      assert.equal(clientKey(withoutTrustedHeader, true), ip);
    }
  });

  test('tracks a bounded number of clients, dropping the oldest', () => {
    const hit = slidingWindow(1, () => 0, 2);

    assert.equal(hit('1.1.1.1').exceeded, false);
    assert.equal(hit('1.1.1.1').exceeded, true);
    hit('2.2.2.2');
    hit('3.3.3.3');
    assert.equal(hit('1.1.1.1').exceeded, false);
  });

  test('holds the limit across a window boundary (no fixed-window burst)', () => {
    let now = 0;
    const hit = slidingWindow(60, () => now);
    const client = '203.0.113.7';

    hit(client); // opens the window at t=0
    now = 59_999; // fill the rest of the window at its very end
    let accepted = 0;
    for (let i = 0; i < 60; i++) if (!hit(client).exceeded) accepted++;

    now = 60_000; // the fixed-window reset point
    for (let i = 0; i < 60; i++) if (!hit(client).exceeded) accepted++;

    // A fixed window would accept ~120 here; a sliding one holds it to the limit.
    assert.ok(accepted <= 60, `accepted ${accepted} across the boundary, expected <= 60`);
  });

  test('does not count the health check', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1 });
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await limited.request('/health')).status, 200);
    }
  });
});

describe('the rest of the surface', () => {
  test('serves the OpenAPI document and the docs page', async () => {
    const spec = await json(await get('/openapi.json'));
    for (const path of [
      '/v1/companies',
      '/v1/companies/{ticker}',
      '/v1/companies/{ticker}/rates/{year}',
      '/v1/purification/calculate',
      '/v1/meta',
    ]) {
      assert.ok(path in spec.paths, `missing ${path}`);
    }
    assert.equal((await get('/docs')).status, 200);
  });

  test('allows cross-origin calls', async () => {
    const response = await app.request('/v1/meta', { headers: { Origin: 'https://example.com' } });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  });

  test('404s unknown paths in the error envelope', async () => {
    const response = await get('/v2/nothing');
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, 'NOT_FOUND');
  });

  test('counts every spelling of a path that reaches an endpoint', async () => {
    const limited = makeTestApp({ dataset, requestsPerMinute: 1, now: () => 0 });
    assert.equal((await limited.request('/v1/meta')).status, 200);
    for (const path of ['/V1/META', '/v1/meta/']) {
      assert.equal((await limited.request(path)).status, 429, path);
    }
  });
});
