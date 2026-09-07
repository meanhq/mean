import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { authorizedPage } from '../packages/core/relay/authentication.js';
import { attach } from '../packages/core/relay/relay.js';
import { moduleOrigin, startModuleRelay } from '../packages/core/relay/server.js';

const pageOrigin = 'http://127.0.0.1:8000';
let relay: Awaited<ReturnType<typeof startModuleRelay>> | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe('Transport and discovery: standalone', () => {
  it('requires explicit loopback origins and keeps same-origin socket authentication unchanged', async () => {
    for (const origins of [[], ['*'], ['null'], ['https://evil.test'], [`${pageOrigin}/`]])
      await expect(startModuleRelay(origins)).rejects.toThrow();
    const req = {
      headers: {
        origin: pageOrigin,
        host: '127.0.0.1:8000',
        'sec-websocket-protocol': 'mean-dom-v1, token',
      },
    } as IncomingMessage;
    expect(authorizedPage(req, pageOrigin, 'token')).toBe(true);
    expect(authorizedPage(req, 'http://127.0.0.1:8001', 'token')).toBe(false);
    expect(authorizedPage(req, 'http://127.0.0.1:8001', 'token', [pageOrigin])).toBe(false);
  });

  it('requires matching Origin or Referer and rejects conflicting headers and token queries', () => {
    const request = (headers: Record<string, string>, url = '/__mean/runtime.js?token=secret') =>
      moduleOrigin(
        { headers, url } as IncomingMessage,
        [pageOrigin, 'http://localhost:8000'],
        'secret',
        'http://127.0.0.1:9000',
      );
    expect(request({ origin: pageOrigin })).toBe(pageOrigin);
    expect(
      request(
        { origin: pageOrigin, referer: 'http://127.0.0.1:9000/__mean/runtime.js' },
        '/__mean/assets/runtime.js',
      ),
    ).toBe(pageOrigin);
    expect(
      request({ referer: 'http://127.0.0.1:9000/__mean/runtime.js' }, '/__mean/assets/runtime.js'),
    ).toBeUndefined();
    expect(request({ referer: `${pageOrigin}/dev` })).toBe(pageOrigin);
    for (const headers of [
      {},
      { origin: 'null' },
      { origin: pageOrigin, referer: 'http://localhost:8000/' },
      { origin: pageOrigin, referer: 'bad' },
    ])
      expect(request(headers)).toBeUndefined();
    for (const url of [
      '/__mean/runtime.js',
      '/__mean/runtime.js?token=bad',
      '/__mean/runtime.js?token=secret&token=secret',
      '/__mean/runtime.js?token=secret&extra=1',
      '/__mean/runtime.js?token=secret?extra',
      '/__mean/assets/runtime.js?token=secret',
    ])
      expect(request({ origin: pageOrigin }, url)).toBeUndefined();
  });

  it('serves authenticated modules with exact CORS and refuses unauthenticated HTTP and sockets', async () => {
    relay = await startModuleRelay([pageOrigin]);
    const src = relay.script.match(/src="([^"]+)"/)?.[1];
    if (!src) throw new Error('Missing module tag');
    const headers = { Origin: pageOrigin, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script' };
    const response = await fetch(src, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(pageOrigin);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const code = await response.text();
    expect(code).toContain(relay.origin);
    for (const [url, patch] of [
      [`${relay.origin}/__mean/runtime.js`, {}],
      [src, { Origin: 'http://localhost:9999' }],
      [src, { Referer: 'http://localhost:9999/' }],
      [src, { 'Sec-Fetch-Dest': 'empty' }],
    ] as const) {
      const denied = await fetch(url, { headers: { ...headers, ...patch } });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
      expect(await denied.text()).toBe('');
    }
    const token = new URL(src).searchParams.get('token');
    if (!token) throw new Error('Missing token');
    const asset = await fetch(`${relay.origin}/__mean/assets/runtime.js`, { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).not.toContain(token);
    for (const [origin, protocols] of [
      [pageOrigin, ['mean-dom-v1']],
      ['http://localhost:9999', ['mean-dom-v1', token]],
    ] as const) {
      const socket = new WebSocket(
        `${relay.origin.replace('http:', 'ws:')}/__mean/dom/v1`,
        [...protocols],
        { origin },
      );
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => {
          socket.terminate();
          reject(new Error('Unauthenticated socket opened'));
        });
        socket.on('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(403);
          res.resume();
          socket.terminate();
          resolve();
        });
        socket.on('error', () => {});
      });
    }
  });

  it('reports each validated backend origin again after Mean reconnects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mean-origin-'));
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const file = join(directory, 'dom-endpoint.json');
    const endpoint = {
      v: 1,
      port: address.port,
      instance: randomUUID(),
      token: randomBytes(32).toString('hex'),
    };
    await writeFile(file, JSON.stringify(endpoint), { mode: 0o600 });
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const local = server.address();
    if (!local || typeof local === 'string') throw new Error('Missing relay');
    const received: Record<string, unknown>[] = [];
    upstream.on('connection', (socket) =>
      socket.on('message', (data) => received.push(JSON.parse(data.toString()))),
    );
    const origins = [pageOrigin, 'http://localhost:8001'];
    const attached = attach(server, {
      origin: `http://127.0.0.1:${local.port}`,
      pageOrigins: origins,
      discoveryFile: file,
    });
    const sockets: WebSocket[] = [];
    try {
      await vi.waitFor(() => expect(upstream.clients.size).toBe(1));
      for (const origin of origins) {
        const socket = new WebSocket(
          `ws://127.0.0.1:${local.port}/__mean/dom/v1`,
          ['mean-dom-v1', attached.pageToken],
          { origin },
        );
        sockets.push(socket);
        await once(socket, 'open');
      }
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received.map((message) => message.origin)).toEqual(origins);
      await writeFile(file, JSON.stringify({ ...endpoint, instance: randomUUID() }));
      await vi.waitFor(() => expect(received).toHaveLength(4));
      expect(received.slice(2)).toEqual(received.slice(0, 2));
    } finally {
      for (const socket of sockets) socket.terminate();
      attached.dispose();
      server.close();
      for (const socket of upstream.clients) socket.terminate();
      upstream.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses production before opening a listener', async () => {
    const run = promisify(execFile);
    await expect(
      run(
        process.execPath,
        ['--import', 'tsx', 'packages/hosts/standalone/cli.ts', '--origin', pageOrigin],
        { env: { ...process.env, NODE_ENV: 'production' } },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: '' });
  });
});
