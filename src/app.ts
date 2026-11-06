import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiScalar } from 'effect/http-api';
import { PUBLIC_URL, REQUESTS_PER_MINUTE } from './config.ts';
import { Dataset } from './data/dataset.ts';
import { makeApi } from './http/api.ts';
import { companiesHandlers } from './http/handlers/companies.ts';
import { healthHandlers, metaHandlers } from './http/handlers/meta.ts';
import { purificationHandlers } from './http/handlers/purification.ts';
import {
  DataVersion,
  EntryLimit,
  JsonBody,
  RateLimit,
  RequestValidation,
  routerMiddleware,
  type KnownRoute,
} from './http/middleware.ts';
import { coverageOf } from './http/schemas.ts';

const DOCS_PATH = '/docs';
const OPENAPI_PATH = '/openapi.json';

const ROBOTS_TXT = 'User-agent: *\nDisallow: /v1/\n';

const pages = [
  HttpRouter.route('GET', '/', HttpServerResponse.redirect(DOCS_PATH)),
  HttpRouter.route(
    'GET',
    '/robots.txt',
    HttpServerResponse.text(ROBOTS_TXT, { headers: { 'Cache-Control': 'public, max-age=86400' } }),
  ),
];

const SCALAR_VERSION = '1.43.5';

// Every method and path the app answers, so a request with the wrong method
// can be told which ones the path takes.
const knownRoutes = (api: ReturnType<typeof makeApi>): Array<KnownRoute> => {
  const routes: Array<KnownRoute> = [
    ...pages.map(({ method, path }) => ({ method, path })),
    { method: 'GET', path: DOCS_PATH },
    { method: 'GET', path: OPENAPI_PATH },
  ];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => routes.push({ method: endpoint.method, path: endpoint.path }),
  });
  return routes;
};

export const AppLayer = Layer.unwrap(
  Effect.gen(function* () {
    const dataset = yield* Dataset;
    const api = makeApi({
      coverage: coverageOf(dataset),
      requestsPerMinute: yield* REQUESTS_PER_MINUTE,
      publicUrl: yield* PUBLIC_URL,
    });

    return Layer.mergeAll(
      HttpApiBuilder.layer(api, { openapiPath: OPENAPI_PATH }).pipe(
        Layer.provide([companiesHandlers(api), purificationHandlers(api), metaHandlers(api), healthHandlers(api)]),
        Layer.provide([RequestValidation.layer, EntryLimit.layer, JsonBody.layer, RateLimit.layer, DataVersion.layer]),
      ),
      HttpApiScalar.layerCdn(api, { path: DOCS_PATH, version: SCALAR_VERSION }),
      HttpRouter.addAll(pages),
      routerMiddleware(knownRoutes(api)),
    );
  }),
);
