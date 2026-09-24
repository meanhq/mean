import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as settle } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { authorizedPage, validOrigin } from '../packages/core/relay/authentication.js';
import { readDiscovery, watchDiscovery } from '../packages/core/relay/discovery.js';
import { attach } from '../packages/core/relay/relay.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.useRealTimers();
});
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mean-relay-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const endpoint = () => ({
  v: 1,
  port: 49321,
  instance: randomUUID(),
  token: randomBytes(32).toString('hex'),
});
const discovery = (directory: string, value = endpoint()) => {
  const path = join(directory, 'dom-endpoint.json');
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  return address.port;
};
const upstreamServer = (options: ConstructorParameters<typeof WebSocketServer>[0]) => {
  const upstream = new WebSocketServer(options);
  cleanup.push(() => {
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
  });
  const connections: WebSocket[] = [];
  upstream.on('connection', (socket) => connections.push(socket));
  return { upstream, connections };
};

describe('Transport and discovery', () => {
  it('accepts only a private regular file with version 1', () => {
    const dir = temp();
    const value = endpoint();
    const path = discovery(dir, value);
    expect(readDiscovery(path).endpoint).toEqual(value);
    chmodSync(path, 0o644);
    expect(readDiscovery(path).reason).toBe('unsafe_file');
    chmodSync(path, 0o600);
    chmodSync(dir, 0o755);
    expect(readDiscovery(path).reason).toBe('unsafe_directory');
    chmodSync(dir, 0o700);
    writeFileSync(path, 'x'.repeat(4097));
    expect(readDiscovery(path).reason).toBe('oversized');
    writeFileSync(path, JSON.stringify({ ...value, v: 2 }));
    expect(readDiscovery(path).reason).toBe('unsupported_version');
    writeFileSync(path, JSON.stringify({ ...value, host: 'example.com' }));
    expect(readDiscovery(path).reason).toBe('invalid_data');
    rmSync(path);
    symlinkSync('/etc/passwd', path);
    expect(readDiscovery(path).reason).toBe('symlink');
  });
  it('watches from the nearest existing parent and sees an atomic replacement', async () => {
    const root = temp();
    const dir = join(root, '.mean');
    const path = join(dir, 'dom-endpoint.json');
    const seen: string[] = [];
    cleanup.push(
      watchDiscovery(
        (result) => seen.push(result.endpoint?.instance ?? result.reason ?? 'invalid_data'),
        path,
      ),
    );
    expect(seen).toEqual(['absent']);
    mkdirSync(dir, { mode: 0o700 });
    const value = endpoint();
    discovery(dir, value);
    await vi.waitFor(() => expect(seen).toEqual(['absent', value.instance]), { timeout: 2000 });
    const next = endpoint();
    const replacement = join(dir, 'next');
    writeFileSync(replacement, JSON.stringify(next), { mode: 0o600 });
    renameSync(replacement, path);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(next.instance), { timeout: 2000 });
  });
});

describe('Lifecycle and the idle guarantee', () => {
  it('retries three times with jitter, then waits for the discovery file to change', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const upstream = new WebSocketServer({ server });
    cleanup.push(() => {
      for (const socket of upstream.clients) socket.terminate();
      upstream.close();
    });
    const connections: WebSocket[] = [];
    upstream.on('connection', (socket) => connections.push(socket));
    const path = discovery(temp(), { ...endpoint(), port: address.port });
    const relay = attach(server, {
      origin: `http://127.0.0.1:${address.port}`,
      discoveryFile: path,
    });
    cleanup.push(() => relay.dispose());
    await settle(40);
    expect(connections).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const [index, low, high] of [
      [0, 199, 102],
      [1, 799, 402],
      [2, 3999, 2002],
    ] as const) {
      const socket = connections[index];
      if (!socket) throw new Error('Missing connection');
      socket.terminate();
      await settle(30);
      await vi.advanceTimersByTimeAsync(low);
      await settle(20);
      expect(connections).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(high);
      await settle(40);
      expect(connections).toHaveLength(index + 2);
    }
    connections.at(-1)?.terminate();
    await settle(30);
    await vi.advanceTimersByTimeAsync(10000);
    await settle(30);
    expect(connections).toHaveLength(4);
    vi.useRealTimers();
    writeFileSync(path, JSON.stringify({ ...endpoint(), port: address.port }));
    await vi.waitFor(() => expect(connections).toHaveLength(5), { timeout: 2000 });
  });
  it('never retries after an authentication failure', async () => {
    const server = createServer();
    let upgrades = 0;
    server.on('upgrade', (_request, socket) => {
      upgrades++;
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    const port = await listen(server);
    const reasons: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const relay = attach(server, {
      origin: `http://127.0.0.1:${port}`,
      discoveryFile: discovery(temp(), { ...endpoint(), port }),
      diagnostic: (reason) => reasons.push(reason),
    });
    cleanup.push(() => relay.dispose());
    await settle(40);
    expect(reasons).toContain('authentication_failed');
    // Authentication failure abandons the endpoint; the whole ladder passes without another attempt.
    await vi.advanceTimersByTimeAsync(10000);
    await settle(40);
    expect(upgrades).toBe(1);
  });
  it('retries a fresh endpoint whose first connection was refused once a listener appears', async () => {
    const server = createServer();
    const port = await listen(server);
    // Take a port and release it, so the first connection is refused with no listener.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const meanPort = (probe.address() as { port: number }).port;
    probe.close();
    await once(probe, 'close');
    const reasons: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const relay = attach(server, {
      origin: `http://127.0.0.1:${port}`,
      discoveryFile: discovery(temp(), { ...endpoint(), port: meanPort }),
      diagnostic: (reason) => reasons.push(reason),
    });
    cleanup.push(() => relay.dispose());
    await settle(40);
    const { upstream, connections } = upstreamServer({ host: '127.0.0.1', port: meanPort });
    await once(upstream, 'listening');
    await vi.advanceTimersByTimeAsync(199);
    await settle(20);
    expect(connections).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(102);
    await settle(40);
    expect(connections).toHaveLength(1);
    expect(reasons).toEqual([]);
  });
  it('drops the pending retry and restarts the ladder when the discovery file changes', async () => {
    const server = createServer();
    const port = await listen(server);
    // The stale endpoint accepts the connection and resets it before the handshake completes.
    const stale = createServer();
    let resets = 0;
    stale.on('upgrade', (_request, socket) => {
      resets++;
      socket.destroy();
    });
    const stalePort = await listen(stale);
    const { upstream, connections } = upstreamServer({ host: '127.0.0.1', port: 0 });
    await once(upstream, 'listening');
    const livePort = (upstream.address() as { port: number }).port;
    const path = discovery(temp(), { ...endpoint(), port: stalePort });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const relay = attach(server, { origin: `http://127.0.0.1:${port}`, discoveryFile: path });
    cleanup.push(() => relay.dispose());
    await settle(40);
    expect(resets).toBe(1);
    await vi.advanceTimersByTimeAsync(301);
    await settle(40);
    expect(resets).toBe(2);
    // The next retry is due in 800 ms to 1200 ms. Advance in small steps so the watcher's
    // coalescing timer runs while the pending retry stays ahead of the clock.
    writeFileSync(path, JSON.stringify({ ...endpoint(), port: livePort }));
    for (let step = 0; step < 20 && !connections.length; step++) {
      await settle(50);
      await vi.advanceTimersByTimeAsync(30);
    }
    await settle(40);
    expect(connections).toHaveLength(1);
    expect(resets).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    await settle(40);
    expect(resets).toBe(2);
    expect(connections).toHaveLength(1);
  });
  it('retries after a handshake timeout', { timeout: 15000 }, async () => {
    const server = createServer();
    const { upstream, connections } = upstreamServer({ noServer: true });
    // The first upgrade is held without a response until the relay's handshake times out.
    const held: Duplex[] = [];
    let upgrades = 0;
    server.on('upgrade', (request, socket, head) => {
      upgrades++;
      if (upgrades === 1) {
        socket.on('error', () => {});
        held.push(socket);
        return;
      }
      upstream.handleUpgrade(request, socket, head, (accepted) =>
        upstream.emit('connection', accepted),
      );
    });
    cleanup.push(() => {
      for (const socket of held) socket.destroy();
    });
    const port = await listen(server);
    const reasons: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const relay = attach(server, {
      origin: `http://127.0.0.1:${port}`,
      discoveryFile: discovery(temp(), { ...endpoint(), port }),
      diagnostic: (reason) => reasons.push(reason),
    });
    cleanup.push(() => relay.dispose());
    await settle(40);
    expect(upgrades).toBe(1);
    // The 5 second handshake timeout is a socket timeout, which the fake timers do not cover.
    await settle(5300);
    expect(reasons).toEqual(['listener_unresponsive']);
    await vi.advanceTimersByTimeAsync(199);
    await settle(20);
    expect(upgrades).toBe(1);
    await vi.advanceTimersByTimeAsync(102);
    await settle(40);
    expect(upgrades).toBe(2);
    expect(connections).toHaveLength(1);
  });
});

describe('Page socket authentication and routing', () => {
  it('requires the exact loopback origin, Host and page token subprotocol', () => {
    const token = randomBytes(32).toString('hex');
    const origin = 'http://localhost:5173';
    const headers = {
      origin,
      host: 'localhost:5173',
      'sec-websocket-protocol': `mean-dom-v1, ${token}`,
    };
    const check = (patch: Record<string, string | undefined>) =>
      authorizedPage({ headers: { ...headers, ...patch } } as IncomingMessage, origin, token);
    expect(check({})).toBe(true);
    for (const invalid of [
      undefined,
      'null',
      '*',
      'http://evil.test:5173',
      'http://localhost:5174',
    ])
      expect(check({ origin: invalid })).toBe(false);
    expect(check({ host: '127.0.0.1:5173' })).toBe(false);
    expect(check({ 'sec-websocket-protocol': 'mean-dom-v1, wrong' })).toBe(false);
    expect(validOrigin('http://localhost:5173/')).toBe(false);
    expect(validOrigin('http://0.0.0.0:5173')).toBe(false);
  });
  it('routes by pageId, replays page.open on reconnect and keeps pages across a Mean restart', async () => {
    const meanServer = createServer();
    meanServer.listen(0, '127.0.0.1');
    await once(meanServer, 'listening');
    cleanup.push(() => meanServer.close());
    const app = createServer();
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    cleanup.push(() => app.close());
    const appPort = (app.address() as { port: number }).port;
    const value = { ...endpoint(), port: (meanServer.address() as { port: number }).port };
    const path = discovery(temp(), value);
    const upstream = new WebSocketServer({ server: meanServer, perMessageDeflate: false });
    cleanup.push(() => {
      for (const c of upstream.clients) c.terminate();
      upstream.close();
    });
    const connections: WebSocket[] = [];
    const received: Record<string, unknown>[] = [];
    upstream.on('connection', (socket, req) => {
      expect(req.url).toBe('/dom/v1');
      expect(req.headers.authorization).toBe(`Bearer ${value.token}`);
      expect(req.headers.origin).toBeUndefined();
      connections.push(socket);
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const relay = attach(app, {
      origin: `http://127.0.0.1:${appPort}`,
      discoveryFile: path,
    });
    cleanup.push(() => relay.dispose());
    await pause(40);
    const page = new WebSocket(
      `ws://127.0.0.1:${appPort}/__mean/dom/v1`,
      ['mean-dom-v1', relay.pageToken],
      { origin: `http://127.0.0.1:${appPort}` },
    );
    cleanup.push(() => page.terminate());
    await once(page, 'open');
    expect(page.protocol).toBe('mean-dom-v1');
    await pause(30);
    const opened = received[0];
    if (!opened) throw new Error('Missing page.open');
    expect(opened.type).toBe('page.open');
    const requestId = randomUUID();
    const response = {
      v: 1,
      type: 'probe.result',
      requestId,
      title: 'fixture',
      visible: true,
      focused: false,
      viewport: { width: 800, height: 600, dpr: 1 },
      pageId: randomUUID(),
    };
    page.send(JSON.stringify(response));
    await pause(30);
    expect(received[1]?.pageId).toBe(opened.pageId);
    const firstConnection = connections[0];
    if (!firstConnection) throw new Error('Missing Mean connection');
    const reply = once(page, 'message');
    firstConnection.send(
      JSON.stringify({
        v: 1,
        type: 'page.message',
        pageId: opened.pageId,
        message: { v: 1, type: 'probe', requestId },
      }),
    );
    expect(JSON.parse((await reply)[0].toString())).toEqual({ v: 1, type: 'probe', requestId });
    firstConnection.terminate();
    await pause(400);
    expect(page.readyState).toBe(WebSocket.OPEN);
    expect(connections).toHaveLength(2);
    expect(received.filter((message) => message.type === 'page.open')).toHaveLength(2);
    expect(received.filter((message) => message.type === 'page.message')).toHaveLength(1);
    const closed = once(page, 'close');
    page.send(Buffer.from('binary'));
    expect((await closed)[0]).toBe(1003);
    for (const [frame, code] of [
      ['{', 1007],
      [JSON.stringify({ v: 2, type: 'probe.result', requestId }), 1002],
      [JSON.stringify({ v: 1, type: 'probe.result', requestId, title: 'x'.repeat(4096) }), 1009],
    ] as const) {
      const invalidPage = new WebSocket(
        `ws://127.0.0.1:${appPort}/__mean/dom/v1`,
        ['mean-dom-v1', relay.pageToken],
        { origin: `http://127.0.0.1:${appPort}` },
      );
      cleanup.push(() => invalidPage.terminate());
      await once(invalidPage, 'open');
      const ended = once(invalidPage, 'close');
      invalidPage.send(frame);
      expect((await ended)[0]).toBe(code);
    }
  });
});
