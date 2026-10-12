import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Option } from 'effect';
import type { HttpServerRequest } from 'effect/http';

const WINDOW_MS = 60_000;

const MAX_CLIENTS = 10_000;

const MAX_IP_LENGTH = 45;

// Cloudflare adds this header (via a Transform Rule) so the origin can prove a
// request came through the edge. A client reaching the origin directly cannot
// supply it, so a forged CF-Connecting-IP no longer buys a fresh rate-limit key.
const ORIGIN_SECRET_HEADER = 'x-naqua-origin-secret';

export interface Hit {
  limit: number;
  remaining: number;
  secondsUntilReset: number;
  exceeded: boolean;
}

// Empty secret: trust the header whenever Render is set (the prior behaviour).
// Non-empty: require the header to match, compared in constant time.
const originProven = (provided: string | undefined, expected: string): boolean => {
  if (expected === '') return true;
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Render's public ingress overwrites CF-Connecting-IP; other deployments trust
// only the socket. A forged CF-Connecting-IP straight to the origin would still
// pass, so `originSecret` can bind that trust to proof the request came via the
// edge; without it, lock the origin to Cloudflare so nothing else can reach it.
export const clientKey = (
  request: HttpServerRequest.HttpServerRequest,
  isRender: boolean,
  originSecret = '',
): string => {
  const trusted = isRender && originProven(request.headers[ORIGIN_SECRET_HEADER], originSecret);
  const forwarded = trusted ? request.headers['cf-connecting-ip']?.trim() : undefined;
  if (forwarded && forwarded.length <= MAX_IP_LENGTH && !forwarded.includes('%') && isIP(forwarded)) return forwarded;
  return Option.getOrElse(request.remoteAddress, () => 'unknown');
};

// A fixed one-minute window per client, held in memory. That is only sound
// while the API runs as a single process; a restart resets every counter.
export const fixedWindow = (limit: number, now: () => number, maxClients = MAX_CLIENTS) => {
  // In the order the windows opened. They all last the same time, so the
  // expired ones are always at the front.
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (client: string): Hit => {
    const currentTime = now();

    for (const [key, window] of windows) {
      if (window.resetAt > currentTime) break;
      windows.delete(key);
    }

    let window = windows.get(client);
    if (!window || window.resetAt <= currentTime) {
      windows.delete(client);
      if (windows.size >= maxClients) windows.delete(windows.keys().next().value!);
      window = { count: 0, resetAt: currentTime + WINDOW_MS };
      windows.set(client, window);
    }
    window.count++;

    return {
      limit,
      remaining: Math.max(0, limit - window.count),
      secondsUntilReset: Math.max(1, Math.ceil((window.resetAt - currentTime) / 1000)),
      exceeded: window.count > limit,
    };
  };
};
