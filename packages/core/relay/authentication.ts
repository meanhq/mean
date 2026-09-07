import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const PAGE_PROTOCOL = 'mean-dom-v1';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.origin === origin &&
      origin.length <= 256
    );
  } catch {
    return false;
  }
}

// The page token travels as the second subprotocol; the server only ever selects the first.
export function authorizedPage(
  req: IncomingMessage,
  origin: string,
  token: string,
  pageOrigins: readonly string[] = [origin],
): boolean {
  if (
    !validOrigin(origin) ||
    !req.headers.origin ||
    !validOrigin(req.headers.origin) ||
    !pageOrigins.includes(req.headers.origin) ||
    req.headers.host !== new URL(origin).host
  )
    return false;
  const protocols = req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim());
  if (protocols?.length !== 2 || protocols[0] !== PAGE_PROTOCOL) return false;
  return matchesToken(protocols[1] ?? '', token);
}

export function matchesToken(value: string, token: string): boolean {
  const candidate = Buffer.from(value);
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
