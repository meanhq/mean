import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createFakeMean, freePort, median, walkTimingScript } from '../fake-mean/helpers.js';

const repo = resolve(import.meta.dirname, '../..');
const home = await mkdtemp(join(tmpdir(), 'mean-python-'));
await mkdir(join(home, '.mean'), { mode: 0o700 });
const mean = await createFakeMean(join(home, '.mean'));
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const processes: ChildProcess[] = [];
const browser = await chromium.launch({ headless: true });
async function backend(script: string, production = false, backendPort = port): Promise<string> {
  const child = spawn('python3', ['fixtures/python/server.py', '--port', String(backendPort)], {
    cwd: repo,
    env: {
      ...process.env,
      MEAN_SCRIPT: script,
      NODE_ENV: production ? 'production' : 'development',
    },
    stdio: 'ignore',
  });
  processes.push(child);
  const url = `http://127.0.0.1:${backendPort}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return url;
    } catch {}
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error('Python backend did not start');
}
try {
  const cli = spawn(process.execPath, ['packages/mean/dist/standalone.js', '--origin', origin], {
    cwd: repo,
    env: { ...process.env, HOME: home, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(cli);
  const script = await new Promise<string>((resolve, reject) => {
    let output = '';
    cli.stdout?.on('data', (data) => {
      output += String(data);
      if (output.includes('\n')) resolve(output.trim());
    });
    cli.once('exit', () => reject(new Error('Standalone CLI exited before printing its tag')));
  });
  assert.match(
    script,
    /^<script type="module" referrerpolicy="no-referrer" src="http:\/\/127\.0\.0\.1:\d+\/__mean\/runtime.js\?token=[a-f0-9]{64}"><\/script>$/,
  );
  const src = script.match(/src="([^"]+)"/)?.[1];
  assert.ok(src);
  const relayOrigin = new URL(src).origin;
  await backend(script);
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript({ content: walkTimingScript });
  const cold: number[] = [];
  const warm: number[] = [];
  const coldRoundtrip: number[] = [];
  const warmRoundtrip: number[] = [];
  for (let index = 0; index < 20; index++) {
    const page = await context.newPage();
    const requests: URL[] = [];
    const referers: string[] = [];
    page.on('request', (request) => {
      requests.push(new URL(request.url()));
      const referer = request.headers().referer;
      if (referer) referers.push(referer);
    });
    await page.goto(origin);
    const opened = await mean.take((item) => item.type === 'page.open' && item.origin === origin);
    assert.notEqual(opened.origin, relayOrigin);
    assert.ok(requests.some((url) => url.pathname === '/__mean/assets/runtime.js'));
    assert.ok(!requests.some((url) => /walk-|detect-/.test(url.pathname)));
    for (let run = 0; run < (index === 19 ? 21 : 1); run++) {
      const probe = await mean.probe(opened.pageId);
      assert.equal(probe.message.type, 'probe.result');
      const result = await mean.walk(
        page,
        opened.pageId,
        String(probe.message.requestId),
        probe.message.viewport as { width: number; height: number },
      );
      assert.equal(result.message.type, 'walk.result');
      const elements = result.message.elements as Record<string, unknown>[];
      assert.ok(elements.some((element) => element.tag === 'button' && element.text === 'Save'));
      assert.ok(
        elements.every(
          (element) =>
            element.framework === 'dom' &&
            element.source === undefined &&
            element.component === undefined &&
            element.chain === undefined,
        ),
      );
      assert.ok(!JSON.stringify(elements).includes('input-secret'));
      assert.ok(!JSON.stringify(elements).includes('editable-secret'));
      (run === 0 ? cold : warm).push(result.pageElapsed);
      (run === 0 ? coldRoundtrip : warmRoundtrip).push(result.elapsed);
    }
    assert.ok(
      requests
        .filter((url) => url.pathname.startsWith('/__mean/'))
        .every((url) => url.origin === relayOrigin),
    );
    assert.ok(referers.every((referer) => !referer.includes('token=')));
    await page.close();
    await mean.take((item) => item.type === 'page.close' && item.pageId === opened.pageId);
  }
  const unlisted = await backend(script, false, await freePort());
  const refusedPage = await context.newPage();
  const refused = refusedPage.waitForEvent('requestfailed', (request) => request.url() === src);
  await refusedPage.goto(unlisted);
  assert.ok((await refused).failure());
  await refusedPage.close();
  assert.equal(
    (
      await fetch(src, {
        headers: { Origin: unlisted, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script' },
      })
    ).status,
    403,
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ['packages/mean/dist/standalone.js', '--origin', origin],
      {
        cwd: repo,
        env: { ...process.env, NODE_ENV: 'production' },
      },
    ),
    { code: 1, stdout: '' },
  );
  const production = await backend(script, true, await freePort());
  const html = await (await fetch(production)).text();
  assert.ok(!html.includes('__mean'));
  assert.equal((await fetch(`${production}/__mean/dom/v1`)).status, 404);
  assert.equal((await fetch(`${production}/__mean/runtime.js`)).status, 404);
  const exited = once(cli, 'exit');
  cli.kill('SIGINT');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(fetch(`${relayOrigin}/__mean/runtime.js`));
  console.log(
    'Python standalone: built public CLI, cross-origin modules, schema-valid walk, source and names absent',
  );
  console.log('Production: script omitted and endpoints unavailable; SIGINT: clean exit');
  console.log(
    `cold page walk p50 (20 fresh pages): ${median(cold).toFixed(2)} ms; roundtrip ${median(coldRoundtrip).toFixed(2)} ms`,
  );
  console.log(
    `warm page walk p50 (20 runs): ${median(warm).toFixed(2)} ms; roundtrip ${median(warmRoundtrip).toFixed(2)} ms`,
  );
  assert.ok(median(cold) <= 20 && median(warm) <= 20);
} finally {
  await browser.close();
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
  mean.close();
  await rm(home, { recursive: true, force: true });
}
