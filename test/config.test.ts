import assert from 'node:assert/strict';
import { ConfigProvider, Effect } from 'effect';
import { test } from 'node:test';
import { IS_RENDER, OTLP_PROTOCOL, REQUESTS_PER_MINUTE } from '../src/config.ts';

const parseLimit = (values: Record<string, unknown>) =>
  Effect.runSync(REQUESTS_PER_MINUTE.parse(ConfigProvider.fromUnknown(values)));

test('rate limit defaults to 60 and accepts a positive integer override', () => {
  assert.equal(parseLimit({}), 60);
  assert.equal(parseLimit({ REQUESTS_PER_MINUTE: '120' }), 120);
});

test('invalid rate-limit settings fail instead of blocking every request', () => {
  for (const value of ['0', '-1', '1.5', 'invalid']) {
    assert.throws(() => parseLimit({ REQUESTS_PER_MINUTE: value }));
  }
});

test('Render header trust is disabled unless configured', () => {
  const parse = (values: Record<string, unknown>) => Effect.runSync(IS_RENDER.parse(ConfigProvider.fromUnknown(values)));
  assert.equal(parse({}), false);
  assert.equal(parse({ RENDER: 'false' }), false);
  assert.equal(parse({ RENDER: 'true' }), true);
});

test('log export uses OTLP over HTTP, protobuf unless JSON is asked for', () => {
  const parse = (values: Record<string, unknown>) => Effect.runSync(OTLP_PROTOCOL.parse(ConfigProvider.fromUnknown(values)));
  assert.equal(parse({}), 'http/protobuf');
  assert.equal(parse({ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }), 'http/json');
  assert.throws(() => parse({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }));
});
