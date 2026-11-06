// After intentional contract changes, run UPDATE_CONTRACT=1 pnpm test and review the diff.
// Ignore Content-Length and validator wording; compare docs by type and outline.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { parseDataset, type LoadedDataset } from '../src/data/dataset.ts';
import { makeTestApp } from './helpers.ts';

const dataset = parseDataset(
  JSON.stringify({
    schemaVersion: 1,
    unit: 'SAR to purify per share held for a full year',
    coverage: { start: '2015-01-01', end: '2024-12-31' },
    companies: [
      {
        ticker: 2222,
        name: 'أرامكو السعودية',
        aliases: [],
        years: { '2023': { rate: 0.0016, status: 'public-sector' }, '2024': { rate: 0.0012, status: 'public-sector' } },
      },
      {
        ticker: 2330,
        name: 'المتقدمة',
        aliases: ['المتقدمة للبتروكيماويات'],
        years: {
          '2015': { rate: null, status: 'non-pure' },
          '2021': { rate: 0.026, status: 'pure' },
          '2022': { rate: 0.018, status: 'mixed' },
          '2023': { rate: 0.0203, status: 'pure' },
        },
      },
    ],
    unresolved: [
      {
        ticker: 9998,
        reason: 'The source lists 2 different companies under this ticker: أ، ب.',
        candidates: [
          { name: 'أ', aliases: [], years: { '2024': { rate: 0.01, status: 'pure' } } },
          { name: 'ب', aliases: [], years: { '2024': { rate: 0.02, status: 'mixed' } } },
        ],
      },
    ],
  }),
);

const CALCULATE = '/v1/purification/calculate';
const post = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }): RequestInit => ({
  method: 'POST',
  headers,
  body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
});
const entry = { ticker: 2330, shares: 100, purchaseDate: '2021-03-01', saleDate: '2023-06-30' };

interface Case {
  requests: [path: string, init?: RequestInit][];
  requestsPerMinute?: number;
  dataset?: LoadedDataset;
  // The case makes the app log an error on purpose.
  quiet?: boolean;
}

const cases: Record<string, Case> = {
  'index': { requests: [['/']] },
  'health': { requests: [['/health']] },
  'meta': { requests: [['/v1/meta']] },
  'company list': { requests: [['/v1/companies']] },
  'company': { requests: [['/v1/companies/2330']] },
  'company: unknown ticker': { requests: [['/v1/companies/9999']] },
  'company: ambiguous ticker': { requests: [['/v1/companies/9998']] },
  'company: ticker that is not a number': { requests: [['/v1/companies/abc']] },
  'company: trailing slash': { requests: [['/v1/companies/']] },
  'rate': { requests: [['/v1/companies/2330/rates/2023']] },
  'rate: year with a status but no rate': { requests: [['/v1/companies/2330/rates/2015']] },
  'rate: year outside the data': { requests: [['/v1/companies/2330/rates/2031']] },
  'rate: ambiguous ticker': { requests: [['/v1/companies/9998/rates/2024']] },
  'rate: year that is not a number': { requests: [['/v1/companies/2330/rates/abc']] },
  'calculate': {
    requests: [
      [
        CALCULATE,
        post({
          entries: [
            entry,
            { ticker: 2222, shares: 10, purchaseDate: '2023-01-01', stillOwned: true },
            { ticker: 2330, shares: 50, year: 2022, daysOwned: 200 },
          ],
        }),
      ],
    ],
  },
  'calculate: unknown ticker': { requests: [[CALCULATE, post({ entries: [entry, { ...entry, ticker: 9999 }] })]] },
  'calculate: ambiguous ticker': { requests: [[CALCULATE, post({ entries: [{ ...entry, ticker: 9998 }] })]] },
  'calculate: a year without a rate': {
    requests: [[CALCULATE, post({ entries: [entry, { ticker: 2330, shares: 1, year: 2015, daysOwned: 10 }] })]],
  },
  'calculate: a rule across fields': {
    requests: [[CALCULATE, post({ entries: [{ ticker: 2330, shares: 1, purchaseDate: '2021-05-01' }] })]],
  },
  'calculate: a field of the wrong type': { requests: [[CALCULATE, post({ entries: [{ ...entry, ticker: '2330' }] })]] },
  'calculate: no entries': { requests: [[CALCULATE, post({ entries: [] })]] },
  'calculate: malformed JSON': { requests: [[CALCULATE, post('not json')]] },
  'calculate: text/plain body': { requests: [[CALCULATE, post({ entries: [entry] }, { 'Content-Type': 'text/plain' })]] },
  'calculate: no Content-Type': {
    requests: [[CALCULATE, post(new TextEncoder().encode(JSON.stringify({ entries: [entry] })), {})]],
  },
  'calculate: body over 100 KB': { requests: [[CALCULATE, post({ entries: [], padding: 'x'.repeat(101 * 1024) })]] },
  'rate limit: the third request in a minute': {
    requestsPerMinute: 2,
    requests: [['/v1/meta'], ['/v1/meta'], ['/v1/meta']],
  },
  'CORS preflight': {
    requests: [
      [
        CALCULATE,
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://trynaqua.com',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        },
      ],
    ],
  },
  'cross-origin GET': { requests: [['/v1/meta', { headers: { Origin: 'https://trynaqua.com' } }]] },
  'HEAD': { requests: [['/v1/meta', { method: 'HEAD' }]] },
  'docs': { requests: [['/docs']] },
  'OpenAPI document': { requests: [['/openapi.json']] },
  'unknown route': { requests: [['/v2/nothing?x=1']] },
  'unknown route under /v1': { requests: [['/v1/nothing']] },
  'wrong method': { requests: [['/v1/meta', post({})]] },
  'wrong method: GET on calculate': { requests: [[CALCULATE]] },
  'wrong method on an unknown path': { requests: [['/v1/nothing', post({})]] },
  'robots.txt': { requests: [['/robots.txt']] },
  'unexpected failure': {
    dataset: {
      ...dataset,
      lookup: () => {
        throw new Error('lookup failed');
      },
    },
    requests: [['/v1/companies/2330']],
    quiet: true,
  },
  // A handler whose body fails its own schema (a ticker of 1.5) has a bug: a
  // 500, not a 400 that blames the request.
  'unexpected failure: a response that breaks its schema': {
    dataset: {
      ...dataset,
      lookup: () => ({ kind: 'found', company: { ...dataset.companies[0]!, ticker: 1.5 } }),
    },
    requests: [['/v1/companies/2330']],
    quiet: true,
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const outline = (spec: Json) => ({
  openapi: spec.openapi,
  info: { title: spec.info.title, version: spec.info.version, description: spec.info.description },
  servers: spec.servers,
  paths: Object.fromEntries(
    Object.entries(spec.paths as Record<string, object>).map(([path, operations]) => [path, Object.keys(operations).sort()]),
  ),
});

const withoutIssueMessages = (body: Json) =>
  body?.error?.code === 'VALIDATION_ERROR' && Array.isArray(body.error.details)
    ? { error: { ...body.error, details: body.error.details.map(({ path }: { path: string }) => ({ path })) } }
    : body;

const parseBody = (path: string, text: string) =>
  path === '/openapi.json' ? outline(JSON.parse(text)) : withoutIssueMessages(JSON.parse(text));

const record = async (path: string, response: Response) => {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'content-length'));
  const text = await response.text();
  const contentType = headers['content-type'] ?? '';
  if (contentType.startsWith('text/html')) {
    return { status: response.status, headers: { ...headers, 'content-type': 'text/html' }, body: '(the docs page)' };
  }
  const isJson = contentType.startsWith('application/json') && text !== '';
  return { status: response.status, headers, body: isJson ? parseBody(path, text) : text };
};

const FIXTURE_URL = new URL('fixtures/contract.json', import.meta.url);
const updating = Boolean(process.env.UPDATE_CONTRACT);
const recorded: Record<string, unknown> = updating ? {} : JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));

describe('the HTTP contract', () => {
  for (const [name, { requests, requestsPerMinute = 60, dataset: caseDataset = dataset, quiet }] of Object.entries(cases)) {
    test(name, async (t) => {
      if (quiet) t.mock.method(console, 'error', () => {});
      const app = makeTestApp({ dataset: caseDataset, requestsPerMinute, now: () => 0 });
      const exchanges = [];
      for (const [path, init] of requests) exchanges.push(await record(path, await app.request(path, init)));

      if (updating) recorded[name] = exchanges;
      else assert.deepEqual(exchanges, recorded[name]);
    });
  }

  test('has a recording for every case and no other', { skip: updating }, () => {
    assert.deepEqual(Object.keys(recorded).sort(), Object.keys(cases).sort());
  });

  after(() => {
    if (updating) writeFileSync(FIXTURE_URL, `${JSON.stringify(recorded, null, 2)}\n`);
  });
});
