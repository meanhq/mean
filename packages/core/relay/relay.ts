import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { isUuid } from '../../protocol/validation.js';
import { authorizedPage, PAGE_PROTOCOL, validOrigin } from './authentication.js';
import { type Endpoint, watchDiscovery } from './discovery.js';
import { decodeFrame, ENVELOPE_OVERHEAD, WALK_LIMIT } from './frames.js';

export const PAGE_PATH = '/__mean/dom/v1';
const RETRY_DELAYS_MS = [250, 1000, 5000];
const HANDSHAKE_TIMEOUT_MS = 5000;
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const PAGE_MESSAGE_TYPES = ['probe.result', 'walk.result', 'error'];

export interface RelayOptions {
  origin: string;
  pageToken?: string;
  pageOrigins?: readonly string[];
  discoveryFile?: string;
  diagnostic?: (reason: string) => void;
}

export function attach(
  server: Server | Http2SecureServer,
  options: RelayOptions,
): { pageToken: string; dispose(): void } {
  if (!validOrigin(options.origin)) throw new Error('Mean supports loopback page origins only');
  const address = server.address();
  if (!address || typeof address === 'string' || !LOOPBACK_ADDRESSES.includes(address.address))
    throw new Error('Mean requires a loopback-only dev server');

  const pageOrigins = [...(options.pageOrigins ?? [options.origin])];
  if (!pageOrigins.length || !pageOrigins.every(validOrigin))
    throw new Error('Mean requires explicit loopback page origins');
  const pageToken = options.pageToken ?? randomBytes(32).toString('hex');
  const pages = new Map<string, { socket: WebSocket; origin: string }>();
  const pageServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: WALK_LIMIT,
    handleProtocols: () => PAGE_PROTOCOL,
  });
  let mean: WebSocket | undefined;
  let endpoint: Endpoint | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let established = false;
  // Set after authentication or protocol failures: no retry until the discovery file changes.
  let abandoned = false;
  let disposed = false;
  let generation = 0;

  function sendToMean(message: unknown): void {
    if (mean?.readyState === WebSocket.OPEN) mean.send(JSON.stringify(message));
  }

  function connect(): void {
    if (!endpoint || disposed || abandoned) return;
    const current = generation;
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/dom/v1`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: WALK_LIMIT + ENVELOPE_OVERHEAD,
    });
    mean = socket;
    socket.on('open', () => {
      if (current !== generation || disposed) {
        socket.terminate();
        return;
      }
      established = true;
      // Replay page.open for live pages only; old walk results are never replayed.
      for (const [pageId, page] of pages) {
        if (page.socket.readyState === WebSocket.OPEN)
          sendToMean({ v: 1, type: 'page.open', pageId, origin: page.origin });
      }
    });
    socket.on('message', (data, binary) => {
      if (current !== generation) return;
      const envelope = decodeFrame(socket, data, binary, true);
      if (!envelope) return;
      if (envelope.type !== 'page.message' || !isUuid(envelope.pageId)) {
        socket.close(1007);
        return;
      }
      const inner = envelope.message;
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        socket.close(1007);
        return;
      }
      const request = inner as Record<string, unknown>;
      if (request.v !== 1) {
        socket.close(1002);
        return;
      }
      if (!isUuid(request.requestId)) {
        socket.close(1007);
        return;
      }
      const page = pages.get(envelope.pageId)?.socket;
      if (page?.readyState === WebSocket.OPEN) page.send(JSON.stringify(inner));
    });
    socket.on('unexpected-response', (_req, response) => {
      if (current !== generation) return;
      abandoned = true;
      options.diagnostic?.(
        response.statusCode === 401 || response.statusCode === 403
          ? 'authentication_failed'
          : 'protocol_mismatch',
      );
      response.resume();
      socket.terminate();
    });
    socket.on('error', (error: Error & { code?: string }) => {
      if (current !== generation) return;
      if (error.message === 'Opening handshake has timed out') {
        options.diagnostic?.('listener_unresponsive');
        return;
      }
      // Network failures may retry; invalid WebSocket handshakes may not.
      if (!error.code || error.code.startsWith('WS_ERR_')) abandoned = true;
    });
    socket.on('close', (code) => {
      if (current !== generation || disposed) return;
      mean = undefined;
      if ([1002, 1003, 1007, 1008, 1009].includes(code)) abandoned = true;
      if (established && !abandoned && attempts < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempts++] ?? 5000;
        retry = setTimeout(connect, delay * (0.8 + Math.random() * 0.4));
      }
    });
  }

  const stopWatching = watchDiscovery((result) => {
    generation++;
    if (retry) clearTimeout(retry);
    mean?.terminate();
    mean = undefined;
    endpoint = result.endpoint;
    attempts = 0;
    established = false;
    abandoned = false;
    if (result.reason) options.diagnostic?.(result.reason);
    if (endpoint) connect();
  }, options.discoveryFile);

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Other upgrade paths belong to the dev server's own HMR socket.
    if (req.url?.split('?')[0] !== PAGE_PATH) return;
    if (req.url !== PAGE_PATH || !authorizedPage(req, options.origin, pageToken, pageOrigins)) {
      options.diagnostic?.('page_rejected');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      socket.destroy();
      return;
    }
    pageServer.handleUpgrade(req, socket, head, (page) => {
      const pageId = randomUUID();
      pages.set(pageId, { socket: page, origin });
      sendToMean({ v: 1, type: 'page.open', pageId, origin });
      page.on('error', () => {});
      page.on('message', (data, binary) => {
        const message = decodeFrame(page, data, binary, false);
        if (!message) return;
        if (!isUuid(message.requestId)) {
          page.close(1007);
          return;
        }
        if (!PAGE_MESSAGE_TYPES.includes(message.type as string)) {
          page.send(
            JSON.stringify({
              v: 1,
              type: 'error',
              requestId: message.requestId,
              code: 'unsupported_type',
            }),
          );
          return;
        }
        sendToMean({ v: 1, type: 'page.message', pageId, message });
      });
      page.on('close', () => {
        pages.delete(pageId);
        sendToMean({ v: 1, type: 'page.close', pageId });
      });
    });
  }
  server.on('upgrade', onUpgrade);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation++;
    stopWatching();
    if (retry) clearTimeout(retry);
    server.off('upgrade', onUpgrade);
    server.off('close', dispose);
    for (const page of pages.values()) page.socket.terminate();
    pages.clear();
    mean?.terminate();
    pageServer.close();
  }
  server.once('close', dispose);
  return { pageToken, dispose };
}
