// Measures the built runtime against any Vite project without changing that project:
//   corepack pnpm exec tsx fixtures/fake-mean/measure.ts <project directory> [path]
// A temporary Vite config swaps the project's mean() plugin for the local build (or the
// dist/vite.js named by MEAN_MEASURE_DIST, for comparing builds) and a temporary HOME keeps
// the fake listener away from a running Mean. MEAN_MEASURE_COSTS=1 also times layout reads.
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createFakeMean, freePort, median, walkTimingScript } from './helpers.js';

const repo = resolve(import.meta.dirname, '../..');
const project = resolve(process.argv[2] ?? join(repo, 'fixtures/vite-react'));
const path = process.argv[3] ?? '/';
const samples = Number(process.env.MEAN_MEASURE_SAMPLES ?? 10);
const dist = resolve(process.env.MEAN_MEASURE_DIST || join(repo, 'packages/mean/dist/vite.js'));

const home = await mkdtemp(join(tmpdir(), 'mean-measure-'));
const meanDirectory = join(home, '.mean');
await mkdir(meanDirectory, { mode: 0o700 });
await chmod(meanDirectory, 0o700);
const port = await freePort();
const configPath = join(home, 'vite.config.mts');
await writeFile(
  configPath,
  [
    `import original from ${JSON.stringify(join(project, 'vite.config.ts'))};`,
    `import { mean } from ${JSON.stringify(dist)};`,
    'const flatten = (plugins) => (Array.isArray(plugins) ? plugins.flatMap(flatten) : [plugins]);',
    'const config = typeof original === "function" ? await original({ command: "serve", mode: "development" }) : original;',
    'export default {',
    '  ...config,',
    `  root: ${JSON.stringify(project)},`,
    '  plugins: [...flatten(config.plugins ?? []).filter((plugin) => plugin?.name !== "mean-dom"), mean()],',
    `  server: { ...config.server, host: "127.0.0.1", port: ${port}, strictPort: true },`,
    '};',
    '',
  ].join('\n'),
);

// Counts and times the layout reads the walk makes; the wrappers add a little overhead of their own.
const layoutInstrumentation = `(() => {
  const costs = { rect: [0, 0], style: [0, 0], ranges: [0, 0], stamp: [0, 0] };
  window.__meanCosts = costs;
  const time = (target, key, name) => {
    const original = target[key];
    target[key] = function (...args) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        costs[name][0] += 1;
        costs[name][1] += performance.now() - started;
      }
    };
  };
  time(Element.prototype, 'getBoundingClientRect', 'rect');
  time(window, 'getComputedStyle', 'style');
  time(Range.prototype, 'getClientRects', 'ranges');
  time(Element.prototype, 'getAttribute', 'stamp');
})();`;

const readCosts = `(() => {
  const costs = window.__meanCosts;
  const snapshot = JSON.parse(JSON.stringify(costs));
  for (const key of Object.keys(costs)) costs[key] = [0, 0];
  return snapshot;
})()`;

let vite: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const mean = await createFakeMean(meanDirectory);
try {
  vite = spawn(
    join(project, 'node_modules/.bin/vite'),
    ['--config', configPath, '--clearScreen', 'false'],
    { cwd: project, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  vite.stdout?.on('data', (chunk) => {
    log += chunk.toString();
  });
  vite.stderr?.on('data', (chunk) => {
    log += chunk.toString();
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try {
      ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${log}`);
    if (!ready) await new Promise((done) => setTimeout(done, 50));
  }
  if (!ready) throw new Error(`Vite did not become ready:\n${log}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript({ content: walkTimingScript });
  if (process.env.MEAN_MEASURE_COSTS)
    await context.addInitScript({ content: layoutInstrumentation });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  const { pageId } = await mean.take((item) => item.type === 'page.open' && item.origin === origin);
  const visible = await page.evaluate(() => {
    let count = 0;
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight
      )
        count++;
    }
    return { count, total: document.querySelectorAll('*').length };
  });

  const runs: Array<{
    parts: number;
    first: number;
    done: number;
    elements: number;
    truncated: boolean;
    costs: Record<string, [number, number]> | undefined;
  }> = [];
  for (let index = 0; index < samples + 1; index++) {
    const probe = await mean.probe(pageId);
    if (probe.message.type !== 'probe.result')
      throw new Error(`Probe failed: ${JSON.stringify(probe.message)}`);
    if (process.env.MEAN_MEASURE_COSTS) await page.evaluate(readCosts);
    const result = await mean.walk(
      page,
      pageId,
      String(probe.message.requestId),
      probe.message.viewport as { width: number; height: number },
    );
    if (result.message.type !== 'walk.result')
      throw new Error(`Walk failed: ${JSON.stringify(result.message)}`);
    const costs = process.env.MEAN_MEASURE_COSTS
      ? ((await page.evaluate(readCosts)) as Record<string, [number, number]>)
      : undefined;
    // The first run warms the lazy modules and adapter detection; it is excluded.
    if (index > 0)
      runs.push({
        parts: result.parts,
        first: result.pageElapsed,
        done: result.pageCompleted,
        elements: (result.message.elements as unknown[]).length,
        truncated: result.message.truncated === true,
        costs,
      });
  }
  const column = (values: number[]) => median(values).toFixed(2);
  const elements = runs.map((run) => run.elements);
  console.log(`project: ${project}${path}`);
  console.log(`runtime: ${dist}`);
  console.log(`dom: ${visible.total} elements, ${visible.count} with a viewport rectangle`);
  console.log(`samples: ${runs.length} warm walks (medians)`);
  console.log(`parts: ${column(runs.map((run) => run.parts))}`);
  console.log(`first part: ${column(runs.map((run) => run.first))} ms page time`);
  console.log(`completion: ${column(runs.map((run) => run.done))} ms page time`);
  console.log(
    `elements: ${column(elements)} (min ${Math.min(...elements)}, max ${Math.max(...elements)}); truncated ${runs.filter((run) => run.truncated).length}/${runs.length}`,
  );
  console.log(
    `per element: ${column(runs.map((run) => (run.done * 1000) / run.elements))} us of page time`,
  );
  if (process.env.MEAN_MEASURE_COSTS) {
    for (const key of ['rect', 'style', 'ranges', 'stamp']) {
      const calls = runs.map((run) => run.costs?.[key]?.[0] ?? 0);
      const time = runs.map((run) => run.costs?.[key]?.[1] ?? 0);
      console.log(`${key}: ${column(calls)} calls, ${column(time)} ms per walk`);
    }
  }
} finally {
  await browser?.close();
  vite?.kill('SIGTERM');
  mean.close();
  await rm(home, { recursive: true, force: true });
}
