import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Page } from 'playwright';
import { type WebSocket, WebSocketServer } from 'ws';

const schemaPath = resolve(import.meta.dirname, '../../packages/protocol/schema/dom.v1.json');
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(schema);
const validateMessage = ajv.compile({ $ref: schema.$id });
const validateRelay = ajv.compile({ $ref: `${schema.$id}#/$defs/relay` });

function assertValid(validate: typeof validateMessage, value: unknown, label: string) {
  if (!validate(value))
    throw new Error(`${label} failed schema validation: ${ajv.errorsText(validate.errors)}`);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('Cannot take the median of no values');
  return value;
}

export async function browserBundleSizes(repo: string): Promise<{
  startupBytes: number;
  totalBytes: number;
  startupFiles: Set<string>;
  dynamicFiles: Set<string>;
  fileCount: number;
}> {
  const directory = resolve(repo, 'packages/mean/dist/browser');
  let files: string[];
  try {
    await Promise.all([
      readFile(resolve(repo, 'packages/mean/dist/vite.js')),
      readFile(resolve(directory, 'runtime.js')),
    ]);
    files = (await readdir(directory)).filter((file) => file.endsWith('.js'));
  } catch (error) {
    throw new Error('Built package is missing. Run `corepack pnpm build` before the fixture.', {
      cause: error,
    });
  }
  const bodies = new Map<string, Buffer>();
  for (const file of files) bodies.set(file, await readFile(resolve(directory, file)));

  const startupFiles = new Set(['runtime.js']);
  const pending = ['runtime.js'];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file) continue;
    const body = bodies.get(file)?.toString('utf8');
    if (!body) throw new Error(`Browser bundle is missing ${file}`);
    for (const match of body.matchAll(
      /(?:import|export)(?!\s*\()\s*(?:[^"']*?from\s*)?["']\.\/(.+?\.js)["']/g,
    )) {
      const dependency = match[1];
      if (dependency && !startupFiles.has(dependency)) {
        startupFiles.add(dependency);
        pending.push(dependency);
      }
    }
  }

  const dynamicFiles = new Set<string>();
  for (const file of startupFiles) {
    const body = bodies.get(file)?.toString('utf8') ?? '';
    for (const match of body.matchAll(/import\(["']\.\/(.+?\.js)["']\)/g)) {
      if (match[1]) dynamicFiles.add(match[1]);
    }
  }
  const gzipBytes = (selected: Iterable<string>) =>
    [...selected].reduce((total, file) => total + gzipSync(bodies.get(file) ?? '').byteLength, 0);
  return {
    startupBytes: gzipBytes(startupFiles),
    totalBytes: gzipBytes(files),
    startupFiles,
    dynamicFiles,
    fileCount: files.length,
  };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a port');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

type Relay = {
  v: 1;
  type: 'page.open' | 'page.close' | 'page.message';
  pageId: string;
  origin?: string;
  message?: Record<string, unknown>;
};

export interface FakeMean {
  take(predicate: (message: Relay) => boolean, timeoutMs?: number): Promise<Relay>;
  probe(pageId: string): Promise<{ message: Record<string, unknown>; elapsed: number }>;
  walk(
    page: Page,
    pageId: string,
    probeId: string,
    viewport: { width: number; height: number },
  ): Promise<{ message: Record<string, unknown>; elapsed: number; pageElapsed: number }>;
  close(): void;
}

export async function createFakeMean(meanDirectory: string): Promise<FakeMean> {
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/dom/v1',
    perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const authorization = Buffer.from(req.headers.authorization ?? '');
      return (
        req.headers.origin === undefined &&
        authorization.length === expectedAuthorization.length &&
        timingSafeEqual(authorization, expectedAuthorization)
      );
    },
  });
  await new Promise<void>((done) => wss.once('listening', done));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Fake Mean did not listen on TCP');
  const endpoint = { v: 1, port: address.port, instance, token };
  const endpointTemp = join(meanDirectory, `dom-endpoint.${process.pid}.json`);
  const endpointPath = join(meanDirectory, 'dom-endpoint.json');
  await writeFile(endpointTemp, JSON.stringify(endpoint), { mode: 0o600 });
  await chmod(endpointTemp, 0o600);
  await rename(endpointTemp, endpointPath);

  let meanSocket: WebSocket | undefined;
  const inbox: Relay[] = [];
  const waiters = new Set<() => void>();
  wss.on('connection', (socket) => {
    meanSocket = socket;
    socket.on('message', (data, binary) => {
      if (binary) throw new Error('Relay sent a binary frame');
      const envelope = JSON.parse(data.toString());
      assertValid(validateRelay, envelope, 'incoming relay envelope');
      if (envelope.type === 'page.message')
        assertValid(validateMessage, envelope.message, 'incoming page message');
      inbox.push(envelope);
      for (const wake of waiters) wake();
    });
  });

  async function take(predicate: (message: Relay) => boolean, timeoutMs = 5000): Promise<Relay> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) {
        const message = inbox.splice(index, 1)[0];
        if (message) return message;
      }
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          done();
        }, 25);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          done();
        };
        waiters.add(wake);
      });
    }
    throw new Error('Timed out waiting for relay message');
  }

  function send(pageId: string, message: Record<string, unknown>) {
    if (!meanSocket) throw new Error('Relay is not connected');
    assertValid(validateMessage, message, 'outgoing page message');
    const envelope = { v: 1, type: 'page.message', pageId, message };
    assertValid(validateRelay, envelope, 'outgoing relay envelope');
    meanSocket.send(JSON.stringify(envelope));
  }

  async function request(
    pageId: string,
    message: Record<string, unknown>,
  ): Promise<{ message: Record<string, unknown>; elapsed: number }> {
    const requestId = message.requestId as string;
    const started = performance.now();
    send(pageId, message);
    const envelope = await take(
      (item) =>
        item.pageId === pageId &&
        item.type === 'page.message' &&
        item.message?.requestId === requestId,
    );
    if (!envelope.message) throw new Error('Relay response omitted its page message');
    return { message: envelope.message, elapsed: performance.now() - started };
  }

  async function probe(
    pageId: string,
  ): Promise<{ message: Record<string, unknown>; elapsed: number }> {
    return request(pageId, { v: 1, type: 'probe', requestId: randomUUID() });
  }

  async function walk(
    page: Page,
    pageId: string,
    probeId: string,
    viewport: { width: number; height: number },
  ): Promise<{ message: Record<string, unknown>; elapsed: number; pageElapsed: number }> {
    const result = await request(pageId, {
      v: 1,
      type: 'walk',
      requestId: randomUUID(),
      probeId,
      webArea: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      deviceScale: 1,
    });
    const pageElapsed = await page.evaluate(() =>
      (window as unknown as { __meanWalkTimings: number[] }).__meanWalkTimings.shift(),
    );
    if (typeof pageElapsed !== 'number')
      throw new Error('Page timing instrumentation missed a walk');
    return { ...result, pageElapsed };
  }

  return {
    take,
    probe,
    walk,
    close: () => {
      wss.close();
    },
  };
}
