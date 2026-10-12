# Security review — naqua-api

2026-10-12 · commit 2d4e39b (before this change)

## Scope and result

A source review plus live fuzzing of a local clone. The application code is well
hardened: no authentication or database, so no auth-bypass, IDOR, or injection
surface; and heavy malformed-input probing produced clean 4xx responses with
**zero** 500-level defects and no crash or hang.

One real, demonstrable weakness was found and fixed: a **rate-limit bypass**
through a forged `CF-Connecting-IP` header when the origin is reachable without
going through Cloudflare. Severity **Medium**.

## Finding: rate-limit bypass via forged `CF-Connecting-IP`

**Where:** `clientKey()` in [src/http/rateLimit.ts](src/http/rateLimit.ts), used
by the `RateLimit` middleware in [src/http/middleware.ts](src/http/middleware.ts).

**Root cause.** The 60-request-per-minute limit is the only abuse control on this
public API. On Render (`RENDER=true`), the limiter keys each client by the
`CF-Connecting-IP` request header. That is correct *only* while every request
arrives through Cloudflare, which overwrites the header. The code trusted the
header based on the `RENDER` flag alone, with no proof the request actually
transited the edge.

**Impact.** A Render web service is public at `*.onrender.com` by default, and
such hostnames are discoverable (DNS history, certificate transparency). An
attacker reaching the origin directly sets `CF-Connecting-IP` itself and gives
each request a fresh value. Every distinct value is a new rate-limit bucket with
full quota, so the limit is bypassed completely — unbounded requests, enabling
scraping and resource/cost abuse, and churn of the in-memory window map. No
confidentiality impact (all data is public and read-only); the impact is
availability and defeating the documented control.

**Proof (local, `REQUESTS_PER_MINUTE=3`, `RENDER=true`):**

| Requests                                   | Before fix          | After fix (no secret header) |
| ------------------------------------------ | ------------------- | ---------------------------- |
| Same forged `CF-Connecting-IP` ×4          | `200 200 200 429`   | `200 200 200 429`            |
| **Rotating** forged `CF-Connecting-IP` ×6  | `200 200 200 200 200 200` (bypass) | `200 200 200 429 429 429` (blocked) |

## Fix

Two layers, both in this change:

1. **Operational (primary).** Documented in the README: lock the Render origin to
   Cloudflare (IP allowlist or Authenticated Origin Pulls) so nothing but the
   edge can reach it.
2. **Code (defence in depth).** New optional `CF_ORIGIN_SECRET`. When set,
   `CF-Connecting-IP` is trusted only on requests that also carry a matching
   `X-Naqua-Origin-Secret` header, which a Cloudflare Transform Rule injects and a
   direct-to-origin request cannot know. Compared in constant time
   (`crypto.timingSafeEqual`). Left empty, behaviour is unchanged, so the pinned
   HTTP contract is unaffected.

With the secret set, a genuine Cloudflare request (secret header present) still
keys each client correctly, and the per-client limit is still enforced:

| Requests (secret configured)                                    | Result            |
| --------------------------------------------------------------- | ----------------- |
| Rotating IP, **no** secret header (forged, direct to origin)    | `200 200 200 429 429 429` |
| Rotating IP **with** correct secret header (real edge traffic)  | `200 ×6`          |
| Same IP with correct secret header ×4                           | `200 200 200 429` |

**Files changed:** `src/config.ts`, `src/http/rateLimit.ts`,
`src/http/middleware.ts`, `README.md`, `render.yaml`. Tests added in
`test/api.test.ts` (and `test/helpers.ts` threads the new config). `pnpm check`
passes: 132 tests, 0 failures.

## Checked and found solid (no change needed)

- **Input validation.** Oversized bodies rejected (413, or a fast connection drop
  for over-limit chunked uploads); deeply nested JSON, `NaN`/`1e308`/float
  `shares`, unicode and overflowing path params, and unknown routes all return
  clean 4xx. No 500 defects observed.
- **Other forwarding headers.** `X-Forwarded-For`, `True-Client-IP`, `X-Real-IP`,
  and `Forwarded` are already ignored for the rate-limit key, with tests.
- **Prototype pollution.** Year keys in the dataset are constrained to `^\d{4}$`,
  and company lookups use a `Map`, so no `__proto__`/`constructor` path.
- **Arithmetic.** No overflow within the validated `shares` and day bounds;
  totals match the website to 10 dp (parity test).

## Lower-priority hardening (not done here)

- Return a clean `413` for over-limit chunked uploads instead of dropping the
  connection, so clients get a typed error.
- Gate Render auto-deploy on CI passing (`render.yaml` sets `autoDeploy: true` on
  `main`).
