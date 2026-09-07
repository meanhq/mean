import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  browserBundleSizes,
  createFakeMean,
  freePort,
  median,
} from '../fixtures/fake-mean/helpers.js';

const instrumentation = `(() => {
 const Native = window.WebSocket;
 const starts = new Map();
 window.__meanWalkTimings = [];
 window.__meanMessages = 0;
 window.__meanSocketCount = 0;
 window.WebSocket = class extends Native {
  constructor(url, protocols) {
   super(url, protocols);
   if (this.url.includes('/__mean/')) window.__meanSocketCount++;
   this.addEventListener('message', event => {
    try { const message = JSON.parse(String(event.data));
     if (message.type === 'walk') starts.set(message.requestId, performance.now());
    } catch {}
   });
  }
  send(data) {
   if (this.url.includes('/__mean/')) window.__meanMessages++;
   try { const message = JSON.parse(String(data)); const start = starts.get(message.requestId);
    if (start !== undefined) { window.__meanWalkTimings.push(performance.now() - start); starts.delete(message.requestId); }
   } catch {}
   super.send(data);
  }
 };
})();`;

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-Number(child.pid), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  // Next forks workers. Signal only this test's detached process group.
  signal('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, 'exit'), delay(3000)]);
  }
  signal('SIGKILL');
}

async function nextProcess(
  root: string,
  args: string[],
  home: string,
  logPath: string,
  origin?: string,
): Promise<ChildProcess> {
  const require = createRequire(join(root, 'package.json'));
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), ...args], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: args[0] === 'dev' ? 'development' : 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  child.stdout?.on('data', (data) => {
    log += String(data);
  });
  child.stderr?.on('data', (data) => {
    log += String(data);
  });
  const deadline = Date.now() + 180_000;
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) {
        if (!origin && child.exitCode === 0) return child;
        throw new Error(`Next ${args[0]} exited (${child.exitCode}); log: ${logPath}`);
      }
      if (origin && /Ready in/.test(log)) {
        const response = await fetch(origin, { signal: AbortSignal.timeout(90_000) });
        if (response.ok) return child;
        throw new Error(`Next returned ${response.status}; log: ${logPath}`);
      }
      await delay(100);
    }
    throw new Error(`Next ${args[0]} timed out; log: ${logPath}`);
  } catch (error) {
    await stop(child);
    throw error;
  } finally {
    await writeFile(logPath, log);
    child.on('exit', () => {
      void writeFile(logPath, log);
    });
  }
}

async function scanProduction(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanProduction(path);
    else if (/\.(?:js|mjs|cjs|json|html|map|rsc|txt)$/.test(entry.name)) {
      expect(
        /__mean|mean-dom-v1|data-mean-source|startRuntime|probe\.result|walk\.result/.test(
          await readFile(path, 'utf8'),
        ),
        `Mean marker in production artifact: ${path}`,
      ).toBe(false);
    }
  }
}

async function rejectsUpgrade(origin: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/__mean/dom/v1`,
      ['mean-dom-v1', '0'.repeat(64)],
      { origin, handshakeTimeout: 1500 },
    );
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('Next ingress accepted a Mean socket'));
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      done();
    });
    // Stock Next can leave unmatched upgrades unanswered. A bounded timeout is refusal, not a 101.
    socket.on('error', () => done());
  });
}

for (const bundler of ['webpack', 'turbopack']) {
  describe(`Install and use: Next ${bundler}`, () => {
    it('resolves App and Pages source, keeps the HMR socket, loads adapters lazily and excludes production', async () => {
      const fixture = resolve('fixtures', `next-${bundler}`);
      const root = await mkdtemp(resolve('fixtures', `.fixture-next-${bundler}-`));
      const home = await mkdtemp(join(tmpdir(), `mean-next-${bundler}-`));
      const logPrefix = join(tmpdir(), `mean-next-e2e-${bundler}-${process.pid}`);
      let child: ChildProcess | undefined;
      let production: ChildProcess | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let fake: Awaited<ReturnType<typeof createFakeMean>> | undefined;
      try {
        await cp(fixture, root, {
          recursive: true,
          filter: (path) => !['node_modules', '.next'].includes(path.split('/').at(-1) ?? ''),
        });
        await mkdir(join(root, 'node_modules/@meanhq'), { recursive: true });
        for (const dependency of ['next', 'react', 'react-dom', '@meanhq/mean']) {
          await symlink(
            join(fixture, 'node_modules', dependency),
            join(root, 'node_modules', dependency),
            'dir',
          );
        }
        await mkdir(join(home, '.mean'), { mode: 0o700 });
        fake = await createFakeMean(join(home, '.mean'));
        const mean = fake;
        const bundles = await browserBundleSizes(resolve('.'));
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1200, height: 800 },
          deviceScaleFactor: 1,
        });
        context.setDefaultTimeout(30_000);
        context.setDefaultNavigationTimeout(90_000);
        await context.addInitScript({ content: instrumentation });
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        child = await nextProcess(
          root,
          ['dev', `--${bundler}`, '--hostname', '127.0.0.1', '--port', String(port)],
          home,
          `${logPrefix}-dev.log`,
          origin,
        );

        async function open(route: string) {
          const page = await context.newPage();
          const requests: Array<{ url: string; referer: string }> = [];
          const bootstrapHeaders: Array<{ referrerPolicy: string; cors: string; cache: string }> =
            [];
          const socketOrigins: string[] = [];
          page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname === '/__mean/dom/v1')
              socketOrigins.push(new URL(socket.url()).origin);
          });
          page.on('request', (request) =>
            requests.push({ url: request.url(), referer: request.headers().referer ?? '' }),
          );
          page.on('response', (response) => {
            if (new URL(response.url()).pathname === '/__mean/runtime.js')
              bootstrapHeaders.push({
                referrerPolicy: response.headers()['referrer-policy'] ?? '',
                cors: response.headers()['access-control-allow-origin'] ?? '',
                cache: response.headers()['cache-control'] ?? '',
              });
          });
          await page.goto(`${origin}${route}`);
          await page.waitForFunction(
            () => document.getElementById('large')?.children.length === 12000,
          );
          // Clicking proves hydration, not merely server HTML with a source stamp.
          await page.locator('#save').click();
          await expect.poll(() => page.locator('#save').textContent()).toBe('Saved');
          await page.locator('#save').click();
          await expect.poll(() => page.locator('#save').textContent()).toBe('Save');
          const { pageId } = await mean.take(
            (item) => item.type === 'page.open' && item.origin === origin,
          );
          expect(
            await page.evaluate(
              () => (window as unknown as { __meanMessages: number }).__meanMessages,
            ),
          ).toBe(0);
          expect(
            requests.some(({ url }) =>
              bundles.dynamicFiles.has(new URL(url).pathname.split('/').at(-1) ?? ''),
            ),
          ).toBe(false);
          expect(bootstrapHeaders).toEqual([
            { referrerPolicy: 'no-referrer', cors: origin, cache: 'no-store' },
          ]);
          const bootstrap = requests.find(
            ({ url }) => new URL(url).pathname === '/__mean/runtime.js',
          );
          if (!bootstrap) throw new Error('Missing independent relay bootstrap');
          expect(new URL(bootstrap.url).origin).not.toBe(origin);
          expect(socketOrigins).toEqual([new URL(bootstrap.url).origin.replace('http:', 'ws:')]);
          return { page, pageId, requests, bootstrapUrl: bootstrap.url };
        }

        async function walk(page: Page, pageId: string, line = 8, text = 'Save'): Promise<number> {
          const probe = await mean.probe(pageId);
          expect(probe.message.type).toBe('probe.result');
          const result = await mean.walk(page, pageId, String(probe.message.requestId), {
            width: 1200,
            height: 800,
          });
          expect(result.message.type).toBe('walk.result');
          const elements = result.message.elements as Array<Record<string, unknown>>;
          const save = elements.find((element) => element.id === 'save');
          expect(save).toMatchObject({
            framework: 'react',
            component: 'SaveButton',
            source: { file: 'components/SaveButton.jsx', line, column: 5 },
            text,
          });
          expect(Array.isArray(save?.chain) ? save.chain.slice(0, 3) : []).toEqual([
            'SaveButton',
            'Editor',
            'App',
          ]);
          const javascript = elements.find((element) => element.id === 'save-js');
          expect(javascript).toMatchObject({
            framework: 'react',
            component: 'JavaScriptButton',
            source: { file: 'components/JavaScriptButton.js', line: 5, column: 5 },
            text: 'Save JavaScript',
          });
          expect(Array.isArray(javascript?.chain) ? javascript.chain.slice(0, 3) : []).toEqual([
            'JavaScriptButton',
            'Editor',
            'App',
          ]);
          return result.pageElapsed;
        }

        for (const route of ['/', '/legacy']) {
          const cold: number[] = [];
          for (let sample = 0; sample < 20; sample++) {
            const current = await open(route);
            cold.push(await walk(current.page, current.pageId));
            const dependencies = current.requests.filter(({ url }) =>
              new URL(url).pathname.startsWith('/__mean/assets/'),
            );
            expect(dependencies.length).toBeGreaterThan(0);
            expect(
              dependencies.some(({ url }) =>
                bundles.dynamicFiles.has(new URL(url).pathname.split('/').at(-1) ?? ''),
              ),
            ).toBe(true);
            for (const request of dependencies) {
              expect(request.referer.includes(current.bootstrapUrl)).toBe(false);
              expect(/[a-f0-9]{64}/.test(request.referer)).toBe(false);
              expect(new URL(request.url).search.length).toBe(0);
            }
            await current.page.close();
            await mean.take((item) => item.type === 'page.close' && item.pageId === current.pageId);
          }
          const current = await open(route);
          await walk(current.page, current.pageId);
          const warm: number[] = [];
          for (let sample = 0; sample < 20; sample++)
            warm.push(await walk(current.page, current.pageId));
          expect(median(cold)).toBeLessThanOrEqual(20);
          expect(median(warm)).toBeLessThanOrEqual(20);
          console.log(
            `Next ${bundler} ${route}: 20 cold p50 ${median(cold).toFixed(2)} ms; 20 warm p50 ${median(warm).toFixed(2)} ms; 12000 rows; schema, source, names, lazy loading and Referer checks passed`,
          );

          const sourcePath = join(root, 'components/SaveButton.jsx');
          const source = await readFile(sourcePath, 'utf8');
          const timeOrigin = await current.page.evaluate(() => performance.timeOrigin);
          await writeFile(
            sourcePath,
            source
              .replace('  return (', '\n  return (')
              .replace("'Saved' : 'Save'", "'Saved' : 'Save updated'"),
          );
          await expect
            .poll(() => current.page.locator('#save').textContent(), { timeout: 30_000 })
            .toBe('Save updated');
          expect(await current.page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          expect(
            await current.page.evaluate(
              () => (window as unknown as { __meanSocketCount: number }).__meanSocketCount,
            ),
          ).toBe(1);
          await walk(current.page, current.pageId, 9, 'Save updated');
          console.log(
            `Next ${bundler} ${route}: component edit HMR preserved page and single Mean socket; updated source line 9 resolved`,
          );
          await current.page.close();
          await mean.take((item) => item.type === 'page.close' && item.pageId === current.pageId);
          await writeFile(sourcePath, source);
        }

        expect(
          (await fetch(`${origin}/__mean/runtime.js`, { signal: AbortSignal.timeout(30_000) }))
            .status,
        ).toBe(404);
        await rejectsUpgrade(origin);
        await browser.close();
        browser = undefined;
        await stop(child);
        child = undefined;
        await rm(join(root, '.next'), { recursive: true, force: true });
        await nextProcess(root, ['build', `--${bundler}`], home, `${logPrefix}-build.log`);
        await scanProduction(join(root, '.next/server'));
        await scanProduction(join(root, '.next/static'));
        production = await nextProcess(
          root,
          ['start', '--hostname', '127.0.0.1', '--port', String(port)],
          home,
          `${logPrefix}-start.log`,
          origin,
        );
        for (const route of ['/', '/legacy']) {
          const html = await (
            await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(10_000) })
          ).text();
          expect(/__mean|data-mean-source|mean-dom-v1/.test(html)).toBe(false);
        }
        for (const path of ['/__mean/runtime.js', '/__mean/assets/runtime.js', '/__mean/dom/v1'])
          expect(
            (await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) })).status,
          ).toBe(404);
        await rejectsUpgrade(origin);
        console.log(
          `Next ${bundler}: production server and client artifacts clean; App and Pages HTML clean; Mean endpoints unavailable; no 101 within 1500 ms; logs ${logPrefix}-*.log`,
        );
      } finally {
        await browser?.close();
        await stop(child);
        await stop(production);
        fake?.close();
        await rm(root, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }, 600_000);
  });
}
