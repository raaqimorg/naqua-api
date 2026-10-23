# AGENTS.md

Public purification API for trynaqua.com. The README covers endpoints, the data
format and deployment. Read it first. This file lists what is easy to get wrong.

## Commands

```bash
pnpm dev            # node --watch src/server.ts on :3000
pnpm check          # typecheck + lint + test (what CI runs)
pnpm data:format    # validate data/companies.json and restore its canonical layout
```

## Rules

- **No build step.** Node 24 strips types and runs `src/*.ts` as-is, in
  production too. Relative imports must end in `.ts`, types need `import type`,
  and enums, namespaces and parameter properties are unavailable
  (`erasableSyntaxOnly` catches them). Do not add a bundler.
- **Effect style.** `Effect.gen` inline, `Effect.fn('name')` for a reusable
  function that returns an Effect. Services are `Context.Service` classes with a
  static `layer`. The domain (`src/domain`) stays plain functions.
- **API errors are the envelope.** Each is a `Schema.Error` class whose fields
  are the `{ error: { code, message, details } }` body, with its status as
  `httpApiStatus`. Only `RouterMiddleware` builds an error response by hand, for
  the two cases no endpoint sees: an unknown route and a defect.
  An endpoint that takes params, a query or a payload needs
  `.middleware(RequestValidation)`; without it a bad request gets a 500, not a 400.
- **Behaviour belongs to endpoints, not paths.** What applies to some endpoints
  (rate limit, data headers, body checks) is an `HttpApiMiddleware` declared in
  `src/http/api.ts`, so its errors are in the OpenAPI document and no other
  spelling of a path can skip it. The router middleware only does what applies
  to every response. Do not branch on `request.url`.
- **`effect` is pinned exactly.** Its HTTP modules are marked unstable, so
  upgrade on purpose and let the contract test catch drift. When you upgrade,
  set `SCALAR_VERSION` in `src/app.ts` to the Scalar version it bundles. Import
  `@effect/platform-node` by module (`@effect/platform-node/NodeRuntime`): its
  index also loads a Redis client.
- **Logs hold no personal data.** The request log in `RouterMiddleware` records
  the method, path, status, duration, user agent, `Origin` and error code. Never
  add the client's address, the query string, the request body, or other headers,
  and clip any text a caller sends. `test/logging.test.ts` checks this. Export
  is configured only through the standard `OTEL_*` variables (`src/logging.ts`).
- **Dates are UTC day numbers** (`src/domain/dates.ts`), never local-time
  `Date` objects. That keeps day counts independent of the server's time zone.
- **The arithmetic mirrors the website.** `purificationAmount` and `sumAmounts`
  round to 10 dp in the same order as the site. The total is summed over every
  year row, not over per-entry subtotals.
- **`data/companies.json` is hand-edited and reviewed as a diff.** Keep it in
  the layout `pnpm data:format` produces; a test fails otherwise. Never guess
  a fix for an `unresolved` ticker, because that is the owner's call.
- **Parity differences are pinned.** `test/fixtures/legacy-differences.json`
  lists every company-year where the API deliberately differs from the website.
  Regenerate it only for an intended change (`UPDATE_DIFFERENCES=1 pnpm test`),
  and review the diff.
- **The HTTP contract is pinned.** `test/fixtures/contract.json` records the
  status, headers and body of every kind of response. Re-record it only for an
  intended change (`UPDATE_CONTRACT=1 pnpm test`), and review the diff.
