import { ByteSize, Clock, Effect, Layer } from 'effect';
import {
  HttpEffect,
  HttpIncomingMessage,
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';
import { IS_RENDER, MAX_BODY_BYTES, REQUESTS_PER_MINUTE } from '../config.ts';
import { Dataset } from '../data/dataset.ts';
import { issueList } from '../data/schema.ts';
import { PayloadTooLarge, RateLimited, ValidationError, errorBody } from './errors.ts';
import { clientKey, slidingWindow } from './rateLimit.ts';
import { MAX_ENTRIES_PER_REQUEST } from './schemas.ts';

// The router's middleware wraps every request, matched or not. The API's
// middleware is declared on endpoints in api.ts, so the errors it raises are
// part of the OpenAPI document.

// HSTS and nosniff matter for every response; the framing and referrer rules
// are for the docs page, the only HTML.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

const cors = HttpMiddleware.cors({
  allowedMethods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'X-Data-Version'],
  maxAge: 86400,
});

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });

const notFound = ({ method, url }: HttpServerRequest.HttpServerRequest) =>
  json(404, errorBody('NOT_FOUND', 'المسار غير موجود.', `No route for ${method} ${url.replace(/\?.*$/s, '')}.`));

const internalError = json(500, errorBody('INTERNAL_ERROR', 'حدث خطأ غير متوقع.', 'An unexpected error occurred.'));

// User-supplied text is cut to this length before it reaches a log line.
const MAX_LOGGED_LENGTH = 256;
const clip = (value: string): string => (value.length > MAX_LOGGED_LENGTH ? `${value.slice(0, MAX_LOGGED_LENGTH)}…` : value);

// The `code` of the error envelope, so failures can be counted by cause.
const errorCode = (response: HttpServerResponse.HttpServerResponse): string | undefined => {
  if (response.status < 400 || response.body._tag !== 'Uint8Array') return undefined;
  try {
    const code: unknown = JSON.parse(new TextDecoder().decode(response.body.body))?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

// One line per request, named after OpenTelemetry's HTTP conventions. It never
// records the client's address or the request body, which holds a person's
// holdings. Render's health checks are left out unless one fails.
const logRequest = (request: HttpServerRequest.HttpServerRequest, response: HttpServerResponse.HttpServerResponse, durationMs: number) => {
  const path = request.url.replace(/[?#].*$/s, '');
  if (path === '/health' && response.status < 400) return Effect.void;

  const userAgent = request.headers['user-agent'];
  const origin = request.headers['origin'];
  const code = errorCode(response);
  const fields: Record<string, string | number> = {
    'http.request.method': request.method,
    'url.path': clip(path),
    'http.response.status_code': response.status,
    duration_ms: Math.round(durationMs * 10) / 10,
    ...(userAgent === undefined ? {} : { 'user_agent.original': clip(userAgent) }),
    ...(origin === undefined ? {} : { 'http.request.header.origin': clip(origin) }),
    ...(code === undefined ? {} : { 'error.type': code }),
  };
  const message = `${request.method} ${clip(path)} ${response.status}`;
  const log = response.status >= 500 ? Effect.logError(message) : Effect.logInfo(message);
  return log.pipe(Effect.annotateLogs(fields));
};

// CORS answers a preflight itself. Any other response gets the security
// headers, and what the router answers on its own, an unknown route or a
// defect, gets the error envelope. Every response is then logged.
export const RouterMiddleware = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const clock = yield* Clock.Clock;
      const start = clock.currentTimeNanosUnsafe();
      const response = yield* cors(
        app.pipe(
          Effect.catchIf(HttpServerError.isHttpServerError, (error) =>
            error.reason._tag === 'RouteNotFound' ? Effect.succeed(notFound(error.request)) : Effect.die(error),
          ),
          Effect.catchDefect((defect) => Effect.as(Effect.logError('Unexpected failure', defect), internalError)),
          Effect.map(HttpServerResponse.setHeaders(SECURITY_HEADERS)),
        ),
      );
      const durationMs = Number(clock.currentTimeNanosUnsafe() - start) / 1e6;
      yield* logRequest(request, response, durationMs);
      return response;
    }),
  { global: true },
);

// Headers for whatever response the request ends with, including a typed error
// that the API encodes after the middleware has returned.
const setResponseHeaders = (headers: Record<string, string>) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, headers)),
  );

// Input validation failures are 400; invalid handler responses must remain 500.
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()('naqua/RequestValidation', {
  error: ValidationError,
}) {
  static readonly layer = HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) => {
    if (error.kind === 'Body' || error.kind === 'ResponseHeaders') return Effect.fail(error);
    const issues = issueList(error.cause.issue);
    if (issues.length === 1 && issues[0]!.message === 'Expected a valid JSON body') {
      return Effect.fail(ValidationError.unparsable());
    }
    return Effect.fail(ValidationError.of(issues));
  });
}

const isJson = (contentType: string | undefined) =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';

// Read undeclared-length bodies here to enforce the limit; the payload decoder
// reuses the cached body. Node fails the read when the limit is exceeded.
const isTooLarge = (request: HttpServerRequest.HttpServerRequest) => {
  const declared = request.headers['content-length'];
  if (declared !== undefined) return Effect.succeed(Number(declared) > MAX_BODY_BYTES);
  return request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.map((text) => Buffer.byteLength(text) > MAX_BODY_BYTES),
    Effect.orElseSucceed(() => true),
  );
};

// Left to Effect, another Content-Type would get a plain-text 415, and a
// missing one would be read as JSON.
export class JsonBody extends HttpApiMiddleware.Service<JsonBody>()('naqua/JsonBody', {
  error: [PayloadTooLarge, ValidationError],
}) {
  static readonly layer = Layer.succeed(
    JsonBody,
    Effect.fn(function* (handler) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (yield* isTooLarge(request)) return yield* PayloadTooLarge.of();
      if (!isJson(request.headers['content-type'])) return yield* ValidationError.unparsable();
      return yield* handler;
    }),
  );
}

// The payload schema checks the length of `entries` only after it has checked
// every entry, and 100 KB holds thousands of them. Count them first; a body
// that is not JSON is left for the decoder to reject.
export class EntryLimit extends HttpApiMiddleware.Service<EntryLimit>()('naqua/EntryLimit', {
  error: ValidationError,
}) {
  static readonly layer = Layer.succeed(
    EntryLimit,
    Effect.fn(function* (handler) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* Effect.orElseSucceed(request.json, () => null);
      const entries = body !== null && typeof body === 'object' && !Array.isArray(body) ? body['entries'] : undefined;
      if (Array.isArray(entries) && entries.length > MAX_ENTRIES_PER_REQUEST) {
        return yield* ValidationError.of([
          { path: 'entries', message: `A request can have at most ${MAX_ENTRIES_PER_REQUEST} entries.` },
        ]);
      }
      return yield* handler;
    }),
  );
}

export class RateLimit extends HttpApiMiddleware.Service<RateLimit>()('naqua/RateLimit', { error: RateLimited }) {
  static readonly layer = Layer.effect(
    RateLimit,
    Effect.gen(function* () {
      // Read while the layer is built, which is how a test's clock reaches it.
      const clock = yield* Clock.Clock;
      const hit = slidingWindow(yield* REQUESTS_PER_MINUTE, () => clock.currentTimeMillisUnsafe());
      const isRender = yield* IS_RENDER;

      return RateLimit.of(
        Effect.fn(function* (handler) {
          const { limit, remaining, secondsUntilReset, exceeded } = hit(clientKey(yield* HttpServerRequest.HttpServerRequest, isRender));
          yield* setResponseHeaders({
            'RateLimit-Limit': String(limit),
            'RateLimit-Remaining': String(remaining),
            'RateLimit-Reset': String(secondsUntilReset),
            ...(exceeded ? { 'Retry-After': String(secondsUntilReset) } : {}),
          });
          if (exceeded) return yield* RateLimited.of(limit, secondsUntilReset);
          return yield* handler;
        }),
      );
    }),
  );
}

// The data only changes with a deploy, so a successful read can be cached.
export class DataVersion extends HttpApiMiddleware.Service<DataVersion>()('naqua/DataVersion') {
  static readonly layer = Layer.effect(
    DataVersion,
    Effect.gen(function* () {
      const { version } = yield* Dataset;

      return DataVersion.of(
        Effect.fn(function* (handler, { endpoint }) {
          yield* setResponseHeaders({ 'X-Data-Version': version });
          const response = yield* handler;
          return endpoint.method === 'GET'
            ? HttpServerResponse.setHeader(response, 'Cache-Control', 'public, max-age=3600')
            : response;
        }),
      );
    }),
  );
}
