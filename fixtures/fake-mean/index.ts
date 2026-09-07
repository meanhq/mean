import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { browserBundleSizes, createFakeMean, freePort, median } from './helpers.js';

const repo = resolve(import.meta.dirname, '../..');
const fixture = resolve(import.meta.dirname, '../vite-react');
const bundleSizes = await browserBundleSizes(repo);
const home = await mkdtemp(join(repo, '.mean-fixture-'));
const meanDirectory = join(home, '.mean');
await mkdir(meanDirectory, { mode: 0o700 });
await chmod(meanDirectory, 0o700);

const mean = await createFakeMean(meanDirectory);
const { take, probe, walk } = mean;

const vitePort = await freePort();
let vite: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  vite = spawn(
    'corepack',
    ['pnpm', '--dir', fixture, 'dev', '--port', String(vitePort), '--strictPort'],
    {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let viteLog = '';
  if (!vite.stdout || !vite.stderr) throw new Error('Vite output pipes are unavailable');
  vite.stdout.on('data', (chunk) => {
    viteLog += chunk.toString();
  });
  vite.stderr.on('data', (chunk) => {
    viteLog += chunk.toString();
  });
  const origin = `http://127.0.0.1:${vitePort}`;
  let viteReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin)).ok) {
        viteReady = true;
        break;
      }
    } catch {}
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteLog}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!viteReady) throw new Error(`Vite did not become ready:\n${viteLog}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript({
    content: `(() => {
      const NativeWebSocket = window.WebSocket;
      const starts = new Map();
      const timings = [];
      window.__meanWalkTimings = timings;
      window.__meanTreeWalks = 0;
      const createTreeWalker = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => {
        window.__meanTreeWalks += 1;
        return createTreeWalker(...args);
      };
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          this.addEventListener('message', (event) => {
            try {
              const message = JSON.parse(String(event.data));
              if (message.type === 'walk') starts.set(message.requestId, performance.now());
            } catch {}
          });
        }
        send(data) {
          try {
            const message = JSON.parse(String(data));
            const started = starts.get(message.requestId);
            if ((message.type === 'walk.result' || message.type === 'error') && started !== undefined) {
              timings.push(performance.now() - started);
              starts.delete(message.requestId);
            }
          } catch {}
          super.send(data);
        }
      };
    })();`,
  });

  async function openFixture(): Promise<{ page: Page; pageId: string; requests: string[] }> {
    const page = await context.newPage();
    const browserErrors: string[] = [];
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    try {
      const opened = await take((item) => item.type === 'page.open' && item.origin === origin);
      return { page, pageId: opened.pageId, requests };
    } catch (error) {
      const runtimeSource = await page.locator('script[data-mean-runtime]').getAttribute('src');
      throw new Error(
        `Page did not open through relay; runtime=${String(runtimeSource)}; browser=${browserErrors.join(' | ')}; vite=${viteLog}`,
        { cause: error },
      );
    }
  }

  const first = await openFixture();
  const requestedBeforeProbe = [...first.requests];
  const treeWalksBeforeProbe = await first.page.evaluate(
    () => (window as unknown as { __meanTreeWalks: number }).__meanTreeWalks,
  );
  if (treeWalksBeforeProbe !== 0)
    throw new Error('Idle runtime walked the DOM before the first probe');
  for (const chunk of bundleSizes.dynamicFiles) {
    if (requestedBeforeProbe.some((path) => path.endsWith(`/${chunk}`))) {
      throw new Error(`Idle runtime loaded ${chunk} before the first probe`);
    }
  }
  const firstProbe = await probe(first.pageId);
  if (
    bundleSizes.dynamicFiles.size > 0 &&
    !first.requests.some((path) =>
      [...bundleSizes.dynamicFiles].some((chunk) => path.endsWith(`/${chunk}`)),
    )
  ) {
    throw new Error('Probe did not lazily request an adapter or walk chunk');
  }
  if (firstProbe.message.type !== 'probe.result')
    throw new Error(`Probe failed: ${JSON.stringify(firstProbe.message)}`);
  const viewport = firstProbe.message.viewport as { width: number; height: number };
  const firstWalk = await walk(
    first.page,
    first.pageId,
    firstProbe.message.requestId as string,
    viewport,
  );
  if (firstWalk.message.type !== 'walk.result')
    throw new Error(`Walk failed: ${JSON.stringify(firstWalk.message)}`);
  const encoded = JSON.stringify(firstWalk.message);
  for (const secret of [
    'input-secret-must-not-appear',
    'editable-secret-must-not-appear',
    'hidden-secret-must-not-appear',
    'iframe-secret-must-not-appear',
  ]) {
    if (encoded.includes(secret)) throw new Error(`Privacy failure: walk exposed ${secret}`);
  }
  const elements = firstWalk.message.elements as Array<Record<string, unknown>>;
  const save = elements.find((element) => element.tag === 'button' && element.text === 'Save');
  if (!save) throw new Error('Walk omitted the visible Save button');
  if (save.framework !== 'react' || save.component !== 'SaveButton') {
    throw new Error(`Save button lacks React identity: ${JSON.stringify(save)}`);
  }
  const source = save.source as { file?: string; line?: number; column?: number } | undefined;
  if (source?.file !== 'src/main.tsx' || source.line !== 11 || source.column !== 5) {
    throw new Error(`Save button source is not exact: ${JSON.stringify(save)}`);
  }
  await first.page.close();
  await take((item) => item.type === 'page.close' && item.pageId === first.pageId);

  const cold: number[] = [];
  const coldRoundtrip: number[] = [];
  for (let index = 0; index < 20; index++) {
    const current = await openFixture();
    const currentProbe = await probe(current.pageId);
    const currentViewport = currentProbe.message.viewport as { width: number; height: number };
    const result = await walk(
      current.page,
      current.pageId,
      currentProbe.message.requestId as string,
      currentViewport,
    );
    if (result.message.type !== 'walk.result')
      throw new Error(`Cold walk failed: ${JSON.stringify(result.message)}`);
    cold.push(result.pageElapsed);
    coldRoundtrip.push(result.elapsed);
    await current.page.close();
    await take((item) => item.type === 'page.close' && item.pageId === current.pageId);
  }

  const warmPage = await openFixture();
  const warm: number[] = [];
  const warmRoundtrip: number[] = [];
  for (let index = 0; index < 20; index++) {
    const currentProbe = await probe(warmPage.pageId);
    const currentViewport = currentProbe.message.viewport as { width: number; height: number };
    const result = await walk(
      warmPage.page,
      warmPage.pageId,
      currentProbe.message.requestId as string,
      currentViewport,
    );
    if (result.message.type !== 'walk.result')
      throw new Error(`Warm walk failed: ${JSON.stringify(result.message)}`);
    warm.push(result.pageElapsed);
    warmRoundtrip.push(result.elapsed);
  }

  console.log('listener: authenticated loopback connection accepted');
  console.log('relay: connected; page opened');
  console.log(`probe: ${firstProbe.message.type}; ${firstProbe.elapsed.toFixed(2)} ms`);
  console.log(
    `walk: ${elements.length} elements; truncated=${String(firstWalk.message.truncated)}; ${firstWalk.elapsed.toFixed(2)} ms`,
  );
  console.log(`source: ${String(save.component)} at ${JSON.stringify(save.source)}`);
  console.log('privacy: input, contenteditable, hidden subtree and iframe contents absent');
  const coldP50 = median(cold);
  const warmP50 = median(warm);
  console.log(
    `cold page walk p50 (20 fresh pages): ${coldP50.toFixed(2)} ms; roundtrip ${median(coldRoundtrip).toFixed(2)} ms; budget 20 ms`,
  );
  console.log(
    `warm page walk p50 (20 runs): ${warmP50.toFixed(2)} ms; roundtrip ${median(warmRoundtrip).toFixed(2)} ms; budget 20 ms`,
  );
  if (coldP50 > 20 || warmP50 > 20) throw new Error('Median page walk exceeded the 20 ms budget');
  console.log(
    `browser gzip: ${bundleSizes.startupBytes} startup bytes across ${bundleSizes.startupFiles.size} files; ${bundleSizes.totalBytes} total bytes across ${bundleSizes.fileCount} files`,
  );
  console.log(
    'lazy loading: no adapter or walk chunk request and no DOM walk before the first probe',
  );
  console.log(
    'browser: Playwright used for reproducible WebSocket instrumentation and a fresh-page headless timing lifecycle',
  );
} finally {
  await browser?.close();
  vite?.kill('SIGTERM');
  mean.close();
  await rm(home, { recursive: true, force: true });
}
