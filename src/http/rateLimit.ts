import { isIP } from 'node:net';
import { Option } from 'effect';
import type { HttpServerRequest } from 'effect/http';

const WINDOW_MS = 60_000;

const MAX_CLIENTS = 10_000;

const MAX_IP_LENGTH = 45;

export interface Hit {
  limit: number;
  remaining: number;
  secondsUntilReset: number;
  exceeded: boolean;
}

// Render's public ingress overwrites CF-Connecting-IP; other deployments trust only the socket.
export const clientKey = (request: HttpServerRequest.HttpServerRequest, isRender: boolean): string => {
  const forwarded = isRender ? request.headers['cf-connecting-ip']?.trim() : undefined;
  if (forwarded && forwarded.length <= MAX_IP_LENGTH && !forwarded.includes('%') && isIP(forwarded)) return forwarded;
  return Option.getOrElse(request.remoteAddress, () => 'unknown');
};

// A sliding one-minute window per client, held in memory. Each client keeps
// the times of its hits in the last minute, so the limit holds over every
// rolling minute. A fixed window resets on a boundary instead, which lets a
// client send its whole quota just before it and again just after. Only sound
// while the API runs as a single process; a restart clears every client.
export const slidingWindow = (limit: number, now: () => number, maxClients = MAX_CLIENTS) => {
  // In the order of each client's latest hit, so the ones whose hits have all
  // aged out are always at the front.
  const clients = new Map<string, number[]>();

  return (client: string): Hit => {
    const currentTime = now();
    const windowStart = currentTime - WINDOW_MS;

    for (const [key, hits] of clients) {
      if (hits.at(-1)! > windowStart) break;
      clients.delete(key);
    }

    const hits = clients.get(client) ?? [];
    while (hits.length > 0 && hits[0]! <= windowStart) hits.shift();

    // A refused request records no hit, so it leaves the client where it is.
    const exceeded = hits.length >= limit;
    if (!exceeded) {
      hits.push(currentTime);
      clients.delete(client);
      if (clients.size >= maxClients) clients.delete(clients.keys().next().value!);
      clients.set(client, hits);
    }

    return {
      limit,
      remaining: Math.max(0, limit - hits.length),
      // When the oldest hit leaves the window, a request is allowed again.
      secondsUntilReset: Math.max(1, Math.ceil((hits[0]! + WINDOW_MS - currentTime) / 1000)),
      exceeded,
    };
  };
};
