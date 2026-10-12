import { readFileSync } from 'node:fs';
import { Clock, ConfigProvider, Effect, Layer, References } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { AppLayer } from '../src/app.ts';
import { DATASET_PATH, Dataset, loadDataset, parseDataset, type LoadedDataset } from '../src/data/dataset.ts';

export const dataset = loadDataset();

const clockFrom = (now: () => number): Clock.Clock => {
  const nanos = () => BigInt(now()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: () => Effect.void,
  };
};

// The whole app in memory, with its own dataset, rate limit and clock.
export const makeTestApp = ({
  dataset,
  requestsPerMinute = 1_000_000,
  isRender = false,
  originSecret = '',
  now,
}: {
  dataset: LoadedDataset;
  requestsPerMinute?: number;
  isRender?: boolean;
  originSecret?: string;
  now?: () => number;
}) => {
  const app = AppLayer.pipe(
    Layer.provide([
      Layer.succeed(Dataset, dataset),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          REQUESTS_PER_MINUTE: requestsPerMinute,
          RENDER: String(isRender),
          CF_ORIGIN_SECRET: originSecret,
        }),
      ),
      now ? Layer.succeed(Clock.Clock, clockFrom(now)) : Layer.empty,
      HttpServer.layerServices,
    ]),
  );
  const { handler } = HttpRouter.toWebHandler(app, {
    disableLogger: true,
    middleware: Effect.provideService(References.MinimumLogLevel, 'None'),
  });
  return { request: (path: string, init?: RequestInit) => handler(new Request(new URL(path, 'http://localhost'), init)) };
};

export const app = makeTestApp({ dataset });

// The real data currently has no disputed ticker, so the 409 path runs against
// a copy of it with one added (9998 is not a Tadawul symbol).
export const AMBIGUOUS_TICKER = 9998;
const withDispute = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
withDispute.unresolved.push({
  ticker: AMBIGUOUS_TICKER,
  reason: 'The source lists 2 different companies under this ticker: أ، ب.',
  candidates: [
    { name: 'أ', aliases: [], years: { '2024': { rate: 0.01, status: 'pure' } } },
    { name: 'ب', aliases: [], years: { '2024': { rate: 0.02, status: 'mixed' } } },
  ],
});
export const disputedApp = makeTestApp({ dataset: parseDataset(JSON.stringify(withDispute)) });

export const get = (path: string) => app.request(path);

export const calculate = (body: unknown) =>
  app.request('/v1/purification/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (response: Response): Promise<any> => response.json();
