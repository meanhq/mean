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

export interface WalkOutcome {
  message: Record<string, unknown>;
  parts: number;
  elapsed: number;
  completed: number;
  pageElapsed: number;
  pageCompleted: number;
}

export interface FakeMean {
  take(predicate: (message: Relay) => boolean, timeoutMs?: number): Promise<Relay>;
  send(pageId: string, message: Record<string, unknown>): void;
  probe(pageId: string): Promise<{ message: Record<string, unknown>; elapsed: number }>;
  walk(
    page: Page,
    pageId: string,
    probeId: string,
    viewport: { width: number; height: number },
  ): Promise<WalkOutcome>;
  close(): void;
}

// Records, per walk request, the page time to its first and final reply, the number of parts and
// the timers set while it ran or after it finished. Installed with addInitScript before the runtime
// module loads; other patches may wrap it again.
export const walkTimingScript = `(() => {
  const Native = window.WebSocket;
  const walks = new Map();
  window.__meanWalks = walks;
  const nativeSetTimeout = window.setTimeout;
  window.setTimeout = function (...args) {
    for (const walk of walks.values()) {
      if (walk.done === undefined) walk.timers += 1;
      else walk.timersAfter += 1;
    }
    return nativeSetTimeout.apply(this, args);
  };
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'walk')
            walks.set(message.requestId, {
              started: performance.now(),
              parts: 0,
              timers: 0,
              timersAfter: 0,
            });
        } catch {}
      });
    }
    send(data) {
      try {
        const message = JSON.parse(String(data));
        const walk = walks.get(message.requestId);
        if (walk && (message.type === 'walk.result' || message.type === 'error')) {
          const elapsed = performance.now() - walk.started;
          walk.parts += 1;
          if (walk.first === undefined) walk.first = elapsed;
          if (message.more !== true) walk.done = elapsed;
        }
      } catch {}
      super.send(data);
    }
  };
})();`;

export interface PageWalkTiming {
  parts: number;
  first: number;
  done: number;
  timers: number;
  timersAfter: number;
}

export async function readWalkTiming(page: Page, requestId: string): Promise<PageWalkTiming> {
  const timing: unknown = await page.evaluate((id) => {
    const walks = (window as unknown as { __meanWalks?: Map<string, unknown> }).__meanWalks;
    const record = walks?.get(id);
    walks?.delete(id);
    return record;
  }, requestId);
  if (
    typeof timing !== 'object' ||
    timing === null ||
    typeof (timing as PageWalkTiming).parts !== 'number' ||
    typeof (timing as PageWalkTiming).first !== 'number' ||
    typeof (timing as PageWalkTiming).done !== 'number' ||
    typeof (timing as PageWalkTiming).timers !== 'number' ||
    typeof (timing as PageWalkTiming).timersAfter !== 'number'
  )
    throw new Error('Page timing instrumentation missed a walk');
  return timing as PageWalkTiming;
}

type Placed = { depth: number; rect: { width: number; height: number } };

// Parts of one walk arrive in order, numbered from 1, each sorted by descending depth then
// ascending area; only the final part may report truncation.
export function mergeParts(parts: Record<string, unknown>[]): Record<string, unknown> {
  const elements: unknown[] = [];
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (parts.length > 1 || part.part !== undefined) {
      if (part.part !== index + 1)
        throw new Error(`Walk part ${String(part.part)} arrived out of order at ${index + 1}`);
      if (part.more !== !last)
        throw new Error(`Walk part ${index + 1} has more=${String(part.more)}`);
    }
    if (!last && part.truncated !== false)
      throw new Error(`Walk part ${index + 1} reported truncation before the final part`);
    if (!Array.isArray(part.elements)) throw new Error(`Walk part ${index + 1} has no elements`);
    const placed = part.elements as Placed[];
    for (let position = 1; position < placed.length; position++) {
      const previous = placed[position - 1];
      const current = placed[position];
      if (!previous || !current) continue;
      const area = (item: Placed) => item.rect.width * item.rect.height;
      if (
        previous.depth < current.depth ||
        (previous.depth === current.depth && area(previous) > area(current))
      )
        throw new Error(`Walk part ${index + 1} is not sorted at element ${position}`);
    }
    elements.push(...part.elements);
  });
  const final = parts.at(-1);
  if (!final) throw new Error('A walk needs at least one part');
  const { part: _part, more: _more, ...merged } = final;
  return { ...merged, elements };
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
  ): Promise<WalkOutcome> {
    const requestId = randomUUID();
    const started = performance.now();
    send(pageId, {
      v: 1,
      type: 'walk',
      requestId,
      probeId,
      webArea: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      deviceScale: 1,
    });
    const parts: Record<string, unknown>[] = [];
    let elapsed = 0;
    let completed = 0;
    for (;;) {
      const envelope = await take(
        (item) =>
          item.pageId === pageId &&
          item.type === 'page.message' &&
          item.message?.requestId === requestId,
      );
      const message = envelope.message;
      if (!message) throw new Error('Relay response omitted its page message');
      completed = performance.now() - started;
      if (parts.length === 0) elapsed = completed;
      if (message.type === 'error') {
        const timing = await readWalkTiming(page, requestId);
        return {
          message,
          parts: parts.length + 1,
          elapsed,
          completed,
          pageElapsed: timing.first,
          pageCompleted: timing.done,
        };
      }
      parts.push(message);
      if (message.more !== true) break;
    }
    const timing = await readWalkTiming(page, requestId);
    if (timing.parts !== parts.length)
      throw new Error(`Page sent ${timing.parts} replies but the relay delivered ${parts.length}`);
    return {
      message: mergeParts(parts),
      parts: parts.length,
      elapsed,
      completed,
      pageElapsed: timing.first,
      pageCompleted: timing.done,
    };
  }

  return {
    take,
    send,
    probe,
    walk,
    close: () => {
      wss.close();
    },
  };
}
