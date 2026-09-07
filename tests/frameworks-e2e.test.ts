import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createFakeMean,
  type FakeMean,
  freePort,
  median,
  readWalkTiming,
  walkTimingScript,
} from '../fixtures/fake-mean/helpers.js';

const repo = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const cases = [
  {
    framework: 'dom',
    label: 'dom',
    directory: 'vite-dom',
    file: 'index.html',
    line: 7,
    column: 5,
    component: undefined,
    selector: 'button',
  },
  {
    framework: 'dom',
    label: 'dom on Vite 8',
    directory: 'vite8-dom',
    file: 'index.html',
    line: 7,
    column: 5,
    component: undefined,
    selector: 'button',
  },
  {
    framework: 'vue',
    label: 'vue',
    directory: 'vue-vite',
    file: 'src/App.vue',
    line: 6,
    column: 3,
    component: 'NamedPanel',
    selector: '#save',
  },
  {
    framework: 'svelte',
    label: 'svelte',
    directory: 'svelte-vite',
    file: 'src/App.svelte',
    line: 6,
    column: 3,
    component: undefined,
    selector: '#save',
  },
  {
    framework: 'react',
    label: 'react',
    directory: 'vite-react',
    file: 'src/main.tsx',
    line: 11,
    column: 5,
    component: 'SaveButton',
    selector: 'button.primary',
  },
];

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const signal = (value: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function start(fixture: string, home: string, preview = false) {
  const port = await freePort();
  const child = spawn(
    'corepack',
    [
      'pnpm',
      '--dir',
      fixture,
      'exec',
      'vite',
      ...(preview ? ['preview'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: repo,
      detached: true,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout?.on('data', (data) => {
    log += data.toString();
  });
  child.stderr?.on('data', (data) => {
    log += data.toString();
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        if ((await fetch(origin)).ok) return { child, origin };
      } catch {}
      if (child.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`Vite did not start: ${log}`);
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function instrument(context: BrowserContext) {
  await context.addInitScript({ content: walkTimingScript });
  await context.addInitScript({ content: 'window.__documentIdentity = Math.random();' });
}

async function stress(page: Page) {
  await page.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'mean-benchmark';
    container.style.cssText =
      'position:fixed;inset:0;display:grid;grid-template-columns:repeat(50,minmax(0,1fr));grid-template-rows:repeat(30,minmax(0,1fr))';
    for (let index = 0; index < 1500; index++) {
      const node = document.createElement('span');
      node.textContent = 'Node';
      container.append(node);
    }
    document.body.append(container);
    if (
      [...container.children].some((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.top < 0 ||
          rect.bottom > innerHeight ||
          rect.left < 0 ||
          rect.right > innerWidth
        );
      })
    )
      throw new Error('Stress nodes must be visible in the viewport');
  });
}

async function assertProduction(directory: string) {
  const forbidden =
    /\/__mean\/|data-mean-(?:source|runtime)|mean-dom-v1|__svelte_meta|dom-endpoint\.json/;
  let artifacts = 0;
  async function scan(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await scan(file);
      else {
        artifacts++;
        const leakedMarker = (await readFile(file, 'utf8')).match(forbidden)?.[0];
        expect(leakedMarker, file).toBeUndefined();
      }
    }
  }
  await scan(join(directory, 'dist'));
  expect(artifacts).toBeGreaterThan(0);
}

async function assertNoEndpoint(origin: string) {
  const upgraded = await new Promise<boolean>((done, reject) => {
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/__mean/dom/v1`,
      ['mean-dom-v1'],
      { origin, handshakeTimeout: 2000 },
    );
    socket.once('open', () => {
      socket.close();
      done(true);
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      done(false);
    });
    socket.once('error', (error) => {
      if (error.message.includes('timed out')) reject(error);
      else done(false);
    });
  });
  expect(upgraded).toBe(false);
  const runtime = await fetch(`${origin}/__mean/runtime.js`);
  expect(runtime.headers.get('content-type') ?? '').not.toMatch(/javascript/i);
  expect(await runtime.text()).not.toMatch(/mean-dom-v1|data-mean-runtime|new WebSocket/);
}

// Spec, Walk algorithm and budget: 2500 visible cells need several parts; each is sorted on its own,
// a new probe closes a pending walk, and the runtime holds no timer once the final part has left.
async function dense(context: BrowserContext, mean: FakeMean, origin: string, label: string) {
  const page = await context.newPage();
  await page.goto(`${origin}/dense.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.cell').length === 2500);
  const { pageId } = await mean.take((item) => item.type === 'page.open' && item.origin === origin);
  const viewport = { width: 1200, height: 800 };
  const probe = await mean.probe(pageId);
  expect(probe.message.type).toBe('probe.result');
  const walk = await mean.walk(page, pageId, String(probe.message.requestId), viewport);
  expect(walk.message.type).toBe('walk.result');
  expect(walk.parts).toBeGreaterThan(1);
  expect(walk.message.truncated).toBe(false);
  const cells = (walk.message.elements as Array<Record<string, unknown>>).filter(
    (element) => element.tag === 'span' && (element.classes as string[])[0] === 'cell',
  );
  expect(cells).toHaveLength(2500);
  expect(new Set(cells.map((cell) => cell.text)).size).toBe(2500);
  expect(walk.pageElapsed).toBeLessThanOrEqual(25);
  const timing = await page.evaluate(() => {
    const walks = (window as unknown as { __meanWalks: Map<string, unknown> }).__meanWalks;
    return [...walks.values()];
  });
  expect(timing).toEqual([]);
  console.log(
    `${label} dense: 2500 cells in ${walk.parts} parts; first part ${walk.pageElapsed.toFixed(2)} ms; complete ${walk.pageCompleted.toFixed(2)} ms; roundtrip ${walk.completed.toFixed(2)} ms`,
  );

  // Timers: one zero-delay timer between parts and none once the final part has left.
  const timed = await mean.probe(pageId);
  const timedWalk = randomUUID();
  mean.send(pageId, {
    v: 1,
    type: 'walk',
    requestId: timedWalk,
    probeId: timed.message.requestId,
    webArea: { x: 0, y: 0, ...viewport },
    deviceScale: 1,
  });
  const received: Record<string, unknown>[] = [];
  do {
    const envelope = await mean.take(
      (item) => item.type === 'page.message' && item.message?.requestId === timedWalk,
    );
    if (envelope.message) received.push(envelope.message);
  } while (received.at(-1)?.more === true);
  await page.waitForTimeout(250);
  const timers = await readWalkTiming(page, timedWalk);
  expect(timers.parts).toBe(received.length);
  expect(timers.timers).toBe(received.length - 1);
  expect(timers.timersAfter).toBe(0);

  // Cancellation: a probe queued behind the walk request reaches the page between slices and
  // closes the walk with a final, truncated part before it is answered. Chromium orders the
  // pending message task and the zero-delay timer as it likes, so the interleaving is retried.
  let cancelledParts: Record<string, unknown>[] = [];
  let attempts = 0;
  while (attempts < 10 && cancelledParts.at(-1)?.truncated !== true) {
    attempts++;
    const cancelled = await mean.probe(pageId);
    const cancelledWalk = randomUUID();
    mean.send(pageId, {
      v: 1,
      type: 'walk',
      requestId: cancelledWalk,
      probeId: cancelled.message.requestId,
      webArea: { x: 0, y: 0, ...viewport },
      deviceScale: 1,
    });
    const interrupting = mean.probe(pageId);
    cancelledParts = [];
    do {
      const envelope = await mean.take(
        (item) => item.type === 'page.message' && item.message?.requestId === cancelledWalk,
      );
      if (envelope.message) cancelledParts.push(envelope.message);
    } while (cancelledParts.at(-1)?.more === true);
    expect((await interrupting).message.type).toBe('probe.result');
    await expect(
      mean.take(
        (item) => item.type === 'page.message' && item.message?.requestId === cancelledWalk,
        200,
      ),
    ).rejects.toThrow();
    const cancelledTiming = await readWalkTiming(page, cancelledWalk);
    expect(cancelledTiming.parts).toBe(cancelledParts.length);
    expect(cancelledTiming.timersAfter).toBe(0);
  }
  const cancelledCount = cancelledParts.reduce(
    (total, part) => total + (part.elements as unknown[]).length,
    0,
  );
  expect(cancelledCount).toBeLessThan(cells.length);
  expect(cancelledParts.at(-1)).toMatchObject({ more: false, truncated: true });
  expect(cancelledParts.at(-1)?.part).toBe(cancelledParts.length);
  console.log(
    `${label} dense: ${received.length} parts on ${timers.timers} zero-delay timers; a probe cancelled a walk after part ${cancelledParts.length - 1} with a final part ${cancelledParts.length} holding ${cancelledCount} of ${cells.length} cells (attempt ${attempts})`,
  );
  await page.close();
  await mean.take((item) => item.type === 'page.close' && item.pageId === pageId);
}

describe.sequential('Framework adapters: Vite integration', () => {
  for (const fixtureCase of cases) {
    it(`${fixtureCase.label}: exact evidence, independent fields, HMR, large-page timing and production exclusion`, async () => {
      const originalFixture = join(repo, 'fixtures', fixtureCase.directory);
      const originalPath = join(originalFixture, fixtureCase.file);
      const original = await readFile(originalPath, 'utf8');
      const home = await mkdtemp(join(tmpdir(), 'mean-framework-e2e-'));
      const fixture = join(home, fixtureCase.directory);
      await cp(originalFixture, fixture, {
        recursive: true,
        filter: (path) => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
      });
      await symlink(join(originalFixture, 'node_modules'), join(fixture, 'node_modules'), 'dir');
      const sourcePath = join(fixture, fixtureCase.file);
      await mkdir(join(home, '.mean'), { mode: 0o700 });
      const mean = await createFakeMean(join(home, '.mean'));
      let server: ChildProcess | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        const dev = await start(fixture, home);
        server = dev.child;
        browser = await chromium.launch({ headless: true });
        console.log(`${fixtureCase.label}: Chromium ${browser.version()}`);
        const context = await browser.newContext({
          viewport: { width: 1200, height: 800 },
          deviceScaleFactor: 1,
        });
        await instrument(context);
        async function open(path = '/') {
          const page = await context.newPage();
          await page.goto(`${dev.origin}${path}`, { waitUntil: 'networkidle' });
          await page.locator(fixtureCase.selector).waitFor();
          const { pageId } = await mean.take(
            (item) => item.type === 'page.open' && item.origin === dev.origin,
          );
          return { page, pageId };
        }
        async function close(current: { page: Page; pageId: string }) {
          await current.page.close();
          await mean.take((item) => item.type === 'page.close' && item.pageId === current.pageId);
        }
        async function freeze(current: { page: Page; pageId: string }) {
          const probe = await mean.probe(current.pageId);
          expect(probe.message.type).toBe('probe.result');
          const walk = await mean.walk(
            current.page,
            current.pageId,
            probe.message.requestId as string,
            probe.message.viewport as { width: number; height: number },
          );
          expect(walk.message.type).toBe('walk.result');
          return { ...walk, probeElapsed: probe.elapsed };
        }
        function button(result: Awaited<ReturnType<typeof freeze>>) {
          const element = (result.message.elements as Array<Record<string, unknown>>).find(
            (item) =>
              item.tag === 'button' &&
              (item.id === 'save' ||
                item.text === 'Save' ||
                item.text === 'Saved' ||
                item.text === 'Other'),
          );
          if (!element) throw new Error('Walk omitted the fixture button');
          return element;
        }
        const exactSource = {
          file: fixtureCase.file,
          line: fixtureCase.line,
          column: fixtureCase.column,
        };
        const current = await open();
        const firstWalk = await freeze(current);
        const first = button(firstWalk);
        expect(first.framework).toBe(fixtureCase.framework);
        expect(first.source).toEqual(exactSource);
        expect(first.component).toBe(fixtureCase.component);
        if (fixtureCase.component) expect((first.chain as string[])[0]).toBe(fixtureCase.component);
        else expect(first).not.toHaveProperty('chain');
        if (fixtureCase.framework === 'svelte') {
          const child = (firstWalk.message.elements as Array<Record<string, unknown>>).find(
            (element) => element.id === 'child',
          );
          expect(child).toMatchObject({
            framework: 'svelte',
            component: 'NamedChild',
            chain: ['NamedChild'],
            source: { file: 'src/NamedChild.svelte', line: 1, column: 1 },
          });
        }
        console.log(
          `${fixtureCase.label}: static fixture source verified separately from dynamic stress DOM`,
        );

        const identity = await current.page.evaluate('window.__documentIdentity');
        let navigations = 0;
        current.page.on('framenavigated', (frame) => {
          if (frame === current.page.mainFrame()) navigations++;
        });
        const changed = original.replace(/\bSave\b/, 'Saved');
        expect(changed).not.toBe(original);
        try {
          await writeFile(sourcePath, changed);
          await current.page.waitForFunction(
            (selector) => document.querySelector(selector)?.textContent?.trim() === 'Saved',
            fixtureCase.selector,
          );
          // Fast Refresh may render before it invalidates a non-boundary entry module.
          await current.page.waitForTimeout(750);
          if (fixtureCase.framework === 'dom') {
            await mean.take((item) => item.type === 'page.close' && item.pageId === current.pageId);
            const reopened = await mean.take(
              (item) => item.type === 'page.open' && item.origin === dev.origin,
            );
            expect(reopened.pageId).not.toBe(current.pageId);
            current.pageId = reopened.pageId;
            expect(await current.page.evaluate('window.__documentIdentity')).not.toBe(identity);
            expect(navigations).toBeGreaterThan(0);
          } else {
            expect(await current.page.evaluate('window.__documentIdentity')).toBe(identity);
            expect(navigations).toBe(0);
          }
          const updated = button(await freeze(current));
          expect(updated.text).toBe('Saved');
          expect(updated.framework).toBe(fixtureCase.framework);
          expect(updated.component).toBe(fixtureCase.component);
          expect(updated.source).toEqual(exactSource);
        } finally {
          await writeFile(sourcePath, original);
        }
        await current.page.waitForFunction(
          (selector) => document.querySelector(selector)?.textContent?.trim() === 'Save',
          fixtureCase.selector,
        );

        if (fixtureCase.framework === 'dom') {
          await mean.take((item) => item.type === 'page.close' && item.pageId === current.pageId);
          current.pageId = (
            await mean.take((item) => item.type === 'page.open' && item.origin === dev.origin)
          ).pageId;
        }

        await close(current);
        const namesOnlyPage = await open();
        await namesOnlyPage.page.evaluate(() => {
          for (const element of document.querySelectorAll('*')) {
            element.removeAttribute('data-mean-source');
            Reflect.deleteProperty(element, '__svelte_meta');
          }
        });
        const namesOnly = button(await freeze(namesOnlyPage));
        expect(namesOnly).not.toHaveProperty('source');
        expect(namesOnly.component).toBe(fixtureCase.component);
        if (!fixtureCase.component) expect(namesOnly).not.toHaveProperty('chain');
        await close(namesOnlyPage);

        const sourceOnlyPage = await open();
        await sourceOnlyPage.page.evaluate(() => {
          for (const element of document.querySelectorAll('*')) {
            for (const key of Object.getOwnPropertyNames(element)) {
              if (
                /^__(?:reactFiber\$|reactInternalInstance\$|vueParentComponent$|vue__$|svelte)/.test(
                  key,
                )
              )
                Reflect.deleteProperty(element, key);
            }
          }
        });
        const sourceOnly = button(await freeze(sourceOnlyPage));
        expect(sourceOnly.source).toEqual(exactSource);
        expect(sourceOnly).not.toHaveProperty('component');
        expect(sourceOnly).not.toHaveProperty('chain');
        await close(sourceOnlyPage);
        if (fixtureCase.framework === 'dom') {
          const other = await open('/other.html');
          const element = button(await freeze(other));
          expect(element.source).toEqual({ file: 'other.html', line: 5, column: 3 });
          expect(element.framework).toBe('dom');
          expect(element).not.toHaveProperty('component');
          expect(element).not.toHaveProperty('chain');
          await close(other);
        }

        if (fixtureCase.framework === 'dom')
          await dense(context, mean, dev.origin, fixtureCase.label);

        const count = 10;
        for (const mode of ['cold', 'warm'] as const) {
          const pageTimes: number[] = [];
          const completions: number[] = [];
          const roundtrips: number[] = [];
          const probes: number[] = [];
          const totals: number[] = [];
          const counts: number[] = [];
          const parts: number[] = [];
          const warm = mode === 'warm' ? await open() : undefined;
          if (warm) {
            await stress(warm.page);
            await freeze(warm);
          }
          try {
            for (let index = 0; index < count; index++) {
              const sample = warm ?? (await open());
              try {
                if (!warm) await stress(sample.page);
                const result = await freeze(sample);
                const elements = result.message.elements as Array<Record<string, unknown>>;
                // Every stress node arrives, across as many parts as the page needs.
                expect(
                  elements.filter((element) => element.tag === 'span' && element.text === 'Node'),
                ).toHaveLength(1500);
                expect(result.message.truncated).toBe(false);
                pageTimes.push(result.pageElapsed);
                completions.push(result.pageCompleted);
                roundtrips.push(result.elapsed);
                probes.push(result.probeElapsed);
                totals.push(result.probeElapsed + result.elapsed);
                counts.push(elements.length);
                parts.push(result.parts);
              } finally {
                if (!warm) await close(sample);
              }
            }
          } finally {
            if (warm) await close(warm);
          }
          console.log(
            `${fixtureCase.label} ${mode}: ${count} samples, 1500 visible dynamic DOM nodes; ${mode === 'cold' ? 'fresh page and first probe including lazy import (browser HTTP cache may be warm)' : 'same page after one excluded warm-up freeze'}; probe p50=${median(probes).toFixed(2)} ms; first part p50=${median(pageTimes).toFixed(2)} ms; complete p50=${median(completions).toFixed(2)} ms; first part roundtrip p50=${median(roundtrips).toFixed(2)} ms; probe and first part roundtrip sum p50=${median(totals).toFixed(2)} ms; parts p50=${median(parts)}; emitted min=${Math.min(...counts)} max=${Math.max(...counts)}`,
          );
          expect(median(pageTimes)).toBeLessThanOrEqual(20);
        }
        await context.close();
        await stop(server);
        server = undefined;
        await exec('corepack', ['pnpm', '--dir', fixture, 'build'], {
          cwd: repo,
          // Vitest sets NODE_ENV=test; production fixtures must not inherit it.
          env: { ...process.env, NODE_ENV: 'production' },
          timeout: 60_000,
        });
        await assertProduction(fixture);
        const preview = await start(fixture, home, true);
        server = preview.child;
        const page = await browser.newPage();
        const sockets: string[] = [];
        page.on('websocket', (socket) => sockets.push(socket.url()));
        await page.goto(preview.origin, { waitUntil: 'networkidle' });
        expect(await page.locator(fixtureCase.selector).textContent()).toContain('Save');
        expect(await page.locator('[data-mean-source], script[data-mean-runtime]').count()).toBe(0);
        expect(sockets).toEqual([]);
        await assertNoEndpoint(preview.origin);
      } finally {
        await browser?.close();
        await stop(server);
        mean.close();
        await rm(home, { recursive: true, force: true });
        expect(await readFile(originalPath, 'utf8')).toBe(original);
      }
    }, 180_000);
  }
});
