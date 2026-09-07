import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { mean } from '../packages/hosts/vite/vite.js';
import { stampJSX } from '../packages/stampers/jsx/stamp.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const root = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mean-vite-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('Source stamps', () => {
  it('stamps host JSX only, with original offsets and a source map', () => {
    const code = 'const x = <>\n  <Button><div {...props}>hello</div><input /></Button>\n</>;';
    const output = stampJSX(code, '/project/src/App.tsx', '/project');
    if (!output) throw new Error('Missing transformed JSX');
    expect(output.code).toContain('<Button>');
    expect(output.code).toContain(
      'data-mean-source={"{\\"file\\":\\"src/App.tsx\\",\\"line\\":2,\\"column\\":11}"}',
    );
    expect(output.code.match(/data-mean-source/g)).toHaveLength(2);
    expect(output.map.sources).toEqual(['/project/src/App.tsx']);
    expect(stampJSX(code, '/elsewhere/App.tsx', '/project')).toBeUndefined();
    expect(stampJSX(code, '/project/node_modules/App.tsx', '/project')).toBeUndefined();
  });
  it('leaves a file unchanged when its syntax does not parse', () => {
    expect(
      stampJSX('@sealed class A { render() { return <div/>; } }', '/project/App.tsx', '/project'),
    ).toBeUndefined();
  });
});

describe('Privacy and security', () => {
  it('stays inactive in test mode and middleware mode', async () => {
    const dir = root();
    writeFileSync(join(dir, 'App.tsx'), 'export const App = () => <button/>;');
    for (const mode of ['test', 'development']) {
      const server = await createServer({
        configFile: false,
        root: dir,
        mode,
        logLevel: 'silent',
        plugins: [mean()],
        server: { middlewareMode: true },
      });
      cleanup.push(() => server.close());
      const output = await server.transformRequest('/App.tsx');
      expect(output?.code).not.toContain('data-mean-source');
      expect(await server.transformIndexHtml('/', '<html><head></head></html>')).not.toContain(
        '__mean',
      );
    }
  });
  it('stamps the original source before other pre plugins run', async () => {
    const dir = root();
    writeFileSync(join(dir, 'App.tsx'), 'export const App = () => <button>Hi</button>;');
    let sawOriginalStamp = false;
    const server = await createServer({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [
        {
          name: 'existing-framework-transform',
          enforce: 'pre',
          transform(code, id) {
            if (id.endsWith('/App.tsx'))
              sawOriginalStamp = code.includes(
                `data-mean-source={${JSON.stringify(JSON.stringify({ file: 'App.tsx', line: 1, column: 26 }))}}`,
              );
          },
        },
        mean(),
      ],
      server: { host: '127.0.0.1' },
    });
    cleanup.push(() => server.close());
    await server.transformRequest('/App.tsx');
    expect(sawOriginalStamp).toBe(true);
  });
  it('serves the runtime as a no-store module to same-origin module fetches only', async () => {
    const dir = root();
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body>Fixture</body></html>');
    const server = await createServer({
      configFile: false,
      root: dir,
      plugins: [mean()],
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'silent',
    });
    cleanup.push(() => server.close());
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Missing listening address');
    const port = address.port;
    const origin = `http://127.0.0.1:${port}`;
    expect(await (await fetch(origin)).text()).toContain('type="module" src="/__mean/runtime.js"');
    expect((await fetch(`${origin}/__mean/runtime.js`)).status).toBe(403);
    const headers = {
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'script',
      'sec-fetch-site': 'same-origin',
    };
    const response = await fetch(`${origin}/__mean/runtime.js`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const code = await response.text();
    expect(code).toContain('startRuntime(');
    expect(code).toContain('/__mean/assets/runtime.js');
    const transport = await fetch(`${origin}/__mean/assets/runtime.js`, { headers });
    expect(transport.status).toBe(200);
    expect(transport.headers.get('cache-control')).toBe('no-store');
    const transportCode = await transport.text();
    expect(transportCode).toMatch(/import\(["']\.\//);
    expect(transportCode).not.toContain('getBoundingClientRect');
    for (const path of [
      'missing.js',
      'vite.js',
      'package.json',
      '%2e%2e%2fvite.js',
      'nested/runtime.js',
      '',
    ]) {
      expect((await fetch(`${origin}/__mean/assets/${path}`, { headers })).status).toBe(404);
    }
    expect(code).toContain('vite:ws:connect');
    expect(code).not.toContain('Bearer');
    expect(
      (
        await fetch(`${origin}/__mean/runtime.js`, {
          headers: { ...headers, Origin: 'http://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/__mean/runtime.js`, {
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
  it('leaves no runtime, endpoint or stamp in a production build', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'index.html'),
      '<html><head></head><body><script type="module" src="/app.js"></script></body></html>',
    );
    writeFileSync(join(dir, 'app.js'), 'document.body.append("production");');
    const result = await build({
      configFile: false,
      root: dir,
      plugins: [mean()],
      logLevel: 'silent',
      build: { write: false, minify: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((result) =>
      'output' in result ? result.output : [],
    );
    const text = outputs
      .map((output) => (output.type === 'chunk' ? output.code : output.source.toString()))
      .join('\n');
    expect(text).toContain('production');
    expect(text).not.toMatch(/__mean|mean-dom|startRuntime|data-mean-source|WebSocket/);
  });
});
