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

// A sliding one-minute window per client, held in memory. Each client keeps the
// timestamps of its hits in the last WINDOW_MS, so the limit holds over every
// rolling minute. A fixed window instead resets on a boundary, which lets a
// client send the whole quota just before it and again just after — up to twice
// the limit in an instant. Only sound as a single process; a restart clears it.
export const slidingWindow = (limit: number, now: () => number, maxClients = MAX_CLIENTS) => {
  // Keyed in last-seen order (each hit re-inserts the client at the end), so the
  // least recently seen is at the front and can be dropped first.
  const clients = new Map<string, number[]>();

  return (client: string): Hit => {
    const currentTime = now();
    const windowStart = currentTime - WINDOW_MS;

    // Drop clients whose most recent hit has aged out. The front is the least
    // recently seen, so once one is still in-window the rest are too.
    for (const [key, hits] of clients) {
      if (hits[hits.length - 1]! > windowStart) break;
      clients.delete(key);
    }

    const hits = clients.get(client) ?? [];
    clients.delete(client);
    while (hits.length > 0 && hits[0]! <= windowStart) hits.shift();

    const exceeded = hits.length >= limit;
    if (!exceeded) hits.push(currentTime);

    if (hits.length === 0) {
      // Blocked with nothing left in the window: nothing to remember.
      if (clients.size >= maxClients) clients.delete(clients.keys().next().value!);
      return { limit, remaining: limit, secondsUntilReset: WINDOW_MS / 1000, exceeded };
    }

    if (clients.size >= maxClients && !clients.has(client)) clients.delete(clients.keys().next().value!);
    clients.set(client, hits);

    return {
      limit,
      remaining: Math.max(0, limit - hits.length),
      // When the oldest hit still in the window ages out, one slot frees up.
      secondsUntilReset: Math.max(1, Math.ceil((hits[0]! + WINDOW_MS - currentTime) / 1000)),
      exceeded,
    };
  };
};
