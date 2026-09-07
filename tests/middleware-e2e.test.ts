import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createFakeMean,
  freePort,
  median,
  walkTimingScript,
} from '../fixtures/fake-mean/helpers.js';

const exec = promisify(execFile);
const instrumentation = `${walkTimingScript}
(() => {
 const Native = window.WebSocket;
 window.__meanMessages = 0;
 window.WebSocket = class extends Native {
  send(data) {
   if (this.url.includes('/__mean/')) window.__meanMessages++;
   super.send(data);
  }
 };
})();`;

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function start(
  root: string,
  port: number,
  home: string,
  production = false,
  originalEntry = false,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [production && !originalEntry ? 'dist/server.mjs' : 'server.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: production ? 'production' : 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout?.on('data', (data) => {
    log += String(data);
  });
  child.stderr?.on('data', (data) => {
    log += String(data);
  });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop(child);
  throw new Error(`Fixture did not listen: ${log}`);
}

async function artifactText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? artifactText(join(directory, entry.name))
          : readFile(join(directory, entry.name), 'utf8'),
      ),
    )
  ).join('\n');
}

async function rejectsUpgrade(origin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/__mean/dom/v1`,
      ['mean-dom-v1', '0'.repeat(64)],
      {
        origin,
        handshakeTimeout: 1000,
      },
    );
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('Production accepted a Mean socket'));
    });
    socket.on('unexpected-response', (_req, response) => {
      response.resume();
      socket.terminate();
      resolve();
    });
    socket.on('error', () => resolve());
  });
}

for (const host of ['webpack', 'rspack', 'express', 'koa']) {
  describe(`Install and use: ${host}`, () => {
    it('walks plain DOM, preserves host reloads and excludes production code', async () => {
      const fixture = resolve('fixtures', host);
      const root = await mkdtemp(resolve('fixtures', `.mean-fixture-${host}-`));
      for (const file of ['server.mjs', 'client.js', 'index.html', 'package.json']) {
        await copyFile(join(fixture, file), join(root, file));
      }
      await symlink(join(fixture, 'node_modules'), join(root, 'node_modules'), 'dir');
      const home = await mkdtemp(join(tmpdir(), 'mean-middleware-'));
      const directory = join(home, '.mean');
      await mkdir(directory, { mode: 0o700 });
      const fake = await createFakeMean(directory);
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1200, height: 800 },
        deviceScaleFactor: 1,
      });
      await context.addInitScript({ content: instrumentation });
      const clientPath = join(root, 'client.js');
      const originalClient = await readFile(clientPath, 'utf8');
      let child: ChildProcess | undefined;
      let production: ChildProcess | undefined;
      try {
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        child = await start(root, port, home);
        async function open(): Promise<{ page: Page; pageId: string }> {
          const page = await context.newPage();
          await page.goto(origin);
          await page.waitForFunction(
            () => document.getElementById('large')?.children.length === 12000,
          );
          const { pageId } = await fake.take(
            (item) => item.type === 'page.open' && item.origin === origin,
          );
          return { page, pageId };
        }
        async function walk(page: Page, pageId: string): Promise<number> {
          const probe = await fake.probe(pageId);
          expect(probe.message.type).toBe('probe.result');
          const result = await fake.walk(page, pageId, String(probe.message.requestId), {
            width: 1200,
            height: 800,
          });
          expect(result.message.type).toBe('walk.result');
          const elements = result.message.elements as Array<Record<string, unknown>>;
          const save = elements.find((element) => element.id === 'save');
          expect(save?.framework).toBe('dom');
          expect(save?.text).toBe('Save');
          expect(
            elements.every(
              (element) =>
                element.component === undefined &&
                element.chain === undefined &&
                element.source === undefined,
            ),
          ).toBe(true);
          return result.pageElapsed;
        }

        const cold: number[] = [];
        for (let index = 0; index < 20; index++) {
          const { page, pageId } = await open();
          expect(
            await page.evaluate(
              () => (window as unknown as { __meanMessages: number }).__meanMessages,
            ),
          ).toBe(0);
          cold.push(await walk(page, pageId));
          await page.close();
          await fake.take((item) => item.type === 'page.close' && item.pageId === pageId);
        }
        const current = await open();
        const warm: number[] = [];
        for (let index = 0; index < 20; index++)
          warm.push(await walk(current.page, current.pageId));
        expect(median(cold)).toBeLessThanOrEqual(20);
        expect(median(warm)).toBeLessThanOrEqual(20);
        console.log(
          `${host}: schema valid; names unavailable; source unavailable; cold p50 ${median(cold).toFixed(2)} ms; warm p50 ${median(warm).toFixed(2)} ms; 20 cold and 20 warm walks; 12000 rows`,
        );

        if (host === 'webpack' || host === 'rspack') {
          const navigation = current.page.evaluate(() => performance.timeOrigin);
          const previousTimeOrigin = await navigation;
          await writeFile(clientPath, originalClient.replace("= 'initial'", "= 'updated'"));
          await current.page.waitForFunction(
            () => document.getElementById('status')?.textContent === 'updated',
          );
          expect(await current.page.evaluate(() => performance.timeOrigin)).toBe(
            previousTimeOrigin,
          );
          await walk(current.page, current.pageId);
          console.log(`${host}: HMR updated without navigation; same Mean page walked`);
        } else {
          await current.page.reload();
          const reopened = await fake.take(
            (item) => item.type === 'page.open' && item.origin === origin,
          );
          await walk(current.page, reopened.pageId);
          console.log(`${host}: native HMR unavailable; reload reconnect verified`);
        }
        await browser.close();
        await stop(child);
        child = undefined;
        production = await start(root, port, home, true, true);
        expect(await (await fetch(origin)).text()).not.toContain('__mean');
        expect((await fetch(`${origin}/__mean/runtime.js`)).status).toBe(404);
        await rejectsUpgrade(origin);
        await stop(production);
        production = undefined;
        await writeFile(clientPath, originalClient);
        await exec(process.execPath, ['server.mjs', '--build'], { cwd: root, timeout: 30_000 });
        expect(await artifactText(join(root, 'dist'))).not.toMatch(
          /__mean|mean-dom-v1|data-mean-source|startRuntime|probe\.result|walk\.result|__reactFiber/,
        );
        production = await start(root, port, home, true);
        for (const path of ['/__mean/runtime.js', '/__mean/assets/runtime.js', '/__mean/dom/v1']) {
          expect((await fetch(`${origin}${path}`)).status).toBe(404);
        }
        await rejectsUpgrade(origin);
        console.log(
          `${host}: production artifacts clean; module, asset and socket endpoints unavailable`,
        );
      } finally {
        await browser.close();
        await stop(child);
        await stop(production);
        fake.close();
        await rm(root, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
