import { Config, Schema } from 'effect';
import packageJson from '../package.json' with { type: 'json' };

export const API_VERSION = packageJson.version;
export const MAX_BODY_BYTES = 100 * 1024;

export const PORT = Config.Port('PORT').pipe(Config.withDefault(3000));
export const PUBLIC_URL = Config.String('PUBLIC_URL').pipe(Config.withDefault('https://api.trynaqua.com'));
export const IS_RENDER = Config.Boolean('RENDER').pipe(Config.withDefault(false));
// When set, `CF-Connecting-IP` is trusted for the rate-limit key only if the
// request also carries this secret in the `X-Naqua-Origin-Secret` header, which
// Cloudflare injects and a request straight to the origin cannot know. Empty
// (the default) keeps the header trusted whenever RENDER is true.
export const CF_ORIGIN_SECRET = Config.String('CF_ORIGIN_SECRET').pipe(Config.withDefault(''));
export const REQUESTS_PER_MINUTE = Config.schema(
  Schema.Int.check(Schema.isGreaterThan(0)),
  'REQUESTS_PER_MINUTE',
).pipe(Config.withDefault(60));
