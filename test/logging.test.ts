import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Logger, References } from 'effect';
import type { LoadedDataset } from '../src/data/dataset.ts';
import { dataset, makeTestApp } from './helpers.ts';

interface Entry {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

// An app whose log lines are kept in `entries`, with Render's trust in
// CF-Connecting-IP, so the rate limiter does read the client's address.
const capture = (appDataset: LoadedDataset = dataset) => {
  const entries: Entry[] = [];
  const logger = Logger.make((options) => {
    entries.push({
      level: options.logLevel,
      message: [options.message].flat().join(' '),
      fields: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const { request } = makeTestApp({ dataset: appDataset, logger, isRender: true });
  return { entries, request };
};

const withoutDuration = ({ duration_ms, ...fields }: Record<string, unknown>) => {
  assert.equal(typeof duration_ms, 'number');
  assert.ok((duration_ms as number) >= 0);
  return fields;
};

describe('request log', () => {
  test('writes one line per request, in OpenTelemetry field names', async () => {
    const { entries, request } = capture();
    await request('/v1/companies/2330', { headers: { 'User-Agent': 'naqua-test/1.0', Origin: 'https://example.com' } });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, 'Info');
    assert.equal(entries[0]!.message, 'GET /v1/companies/2330 200');
    assert.deepEqual(withoutDuration(entries[0]!.fields), {
      'http.request.method': 'GET',
      'url.path': '/v1/companies/2330',
      'http.response.status_code': 200,
      'user_agent.original': 'naqua-test/1.0',
      'http.request.header.origin': 'https://example.com',
    });
  });

  test('names the error of a failed request', async () => {
    const { entries, request } = capture();
    await request('/v1/companies/9999');
    await request('/v1/purification/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    });

    assert.deepEqual(
      entries.map(({ level, fields }) => [level, fields['http.response.status_code'], fields['error.type']]),
      [
        ['Info', 404, 'UNKNOWN_TICKER'],
        ['Info', 400, 'VALIDATION_ERROR'],
      ],
    );
  });

  test('logs a server error at the error level', async () => {
    const broken = { ...dataset, lookup: () => { throw new Error('lookup failed'); } };
    const { entries, request } = capture(broken);
    await request('/v1/companies/2330');

    const line = entries.find((entry) => entry.message === 'GET /v1/companies/2330 500');
    assert.equal(line?.level, 'Error');
    assert.equal(line?.fields['error.type'], 'INTERNAL_ERROR');
  });

  test('never records the client address, the query string or the request body', async () => {
    const { entries, request } = capture();
    await request('/v1/companies/2330?token=hunter2', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.9' },
    });
    await request('/v1/purification/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify({ entries: [{ ticker: 9589, shares: 4242, year: 2025, daysOwned: 365 }] }),
    });

    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.fields['url.path'], '/v1/companies/2330');
    const logged = JSON.stringify(entries);
    for (const secret of ['203.0.113.7', '198.51.100.9', 'hunter2', '4242', '9589']) {
      assert.ok(!logged.includes(secret), `${secret} reached the log`);
    }
  });

  test('leaves out passing health checks', async () => {
    const { entries, request } = capture();
    await request('/health');
    assert.deepEqual(entries, []);
  });

  test('cuts long user-supplied text short', async () => {
    const { entries, request } = capture();
    await request('/v1/companies/2330', { headers: { 'User-Agent': 'x'.repeat(10_000) } });
    assert.equal(entries[0]!.fields['user_agent.original'], `${'x'.repeat(256)}…`);
  });
});
