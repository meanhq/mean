import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextConfig } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextCacheDirectory, nextModuleUrl } from '../packages/hosts/next/listener.js';
import { withMean } from '../packages/hosts/next/next.js';
import stampLoader from '../packages/stampers/jsx/loader.js';
import { stampJSX } from '../packages/stampers/jsx/stamp.js';

vi.mock('../packages/hosts/next/listener.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/hosts/next/listener.js')>()),
  nextModuleUrl: vi.fn(),
}));
const context = { defaultConfig: {} };
let root = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mean-next-config-')));
  await mkdir(join(root, 'node_modules/next'), { recursive: true });
  await mkdir(nextCacheDirectory(root), { recursive: true });
  await writeFile(
    join(root, 'node_modules/next/package.json'),
    JSON.stringify({ version: '16.3.4' }),
  );
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('__NEXT_PRIVATE_ORIGIN', 'http://localhost:3210');
  vi.stubEnv('PORT', '3210');
  vi.mocked(nextModuleUrl).mockResolvedValue(
    `http://127.0.0.1:4567/__mean/runtime.js?token=${'a'.repeat(64)}`,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('Privacy and security: Next configuration', () => {
  it('returns the exact production object for object, promise and function configurations', async () => {
    const base: NextConfig = { reactStrictMode: true, instrumentationClientInject: ['user.js'] };
    for (const phase of ['phase-production-build', 'phase-production-server', 'phase-export']) {
      expect(await withMean(base)(phase, context)).toBe(base);
      expect(await withMean(Promise.resolve(base))(phase, context)).toBe(base);
      const user = vi.fn(async () => base);
      expect(await withMean(user)(phase, context)).toBe(base);
      expect(user).toHaveBeenCalledWith(phase, context);
    }
    expect(nextModuleUrl).not.toHaveBeenCalled();
  });

  it('disables injection when the actual served origin is absent, inconsistent or unsupported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = {};
    for (const origin of [
      '',
      'http://localhost:3211',
      'http://0.0.0.0:3210',
      'https://localhost:3210',
    ]) {
      vi.stubEnv('__NEXT_PRIVATE_ORIGIN', origin);
      expect(await withMean(base)('phase-development-server', context)).toBe(base);
    }
    expect(nextModuleUrl).not.toHaveBeenCalled();
  });

  it('leaves pre-16.3 versions unchanged and reports a diagnostic without a payload', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(
      join(root, 'node_modules/next/package.json'),
      JSON.stringify({ version: '16.2.0' }),
    );
    const base = {};
    expect(await withMean(base)('phase-development-server', context)).toBe(base);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('requires Next 16.3'));
    expect(nextModuleUrl).not.toHaveBeenCalled();
  });
});

describe('Install and use: Next', () => {
  it('pins the Next 16.3.4 source that sets the actual origin before loading config', async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('next/dist/server/lib/start-server.js'));
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'e159ce0a01c778638e47d292dc55042e85339a7dd0ce87ddffef166b63c7378e',
    );
  });

  it('composes user hooks and loader rule forms without changing rewrites', async () => {
    const rewrite = vi.fn(async () => [{ source: '/old', destination: '/new' }]);
    const webpack = vi.fn((config: unknown) => config);
    const forms: Array<NonNullable<NonNullable<NextConfig['turbopack']>['rules']>[string]> = [
      { loaders: ['user-loader'], condition: 'browser' },
      ['user-loader', { loader: 'other-loader', options: { flag: true } }],
      [{ loaders: ['user-loader'], condition: 'browser' }, { loaders: ['other-loader'] }],
    ];
    for (const rule of forms) {
      const base: NextConfig = {
        rewrites: rewrite,
        webpack,
        instrumentationClientInject: ['user.js'],
        turbopack: { rules: { '*.tsx': rule, '*.svg': ['svg-loader'] } },
      };
      const result = await withMean(async () => base)('phase-development-server', context);
      expect(result.rewrites).toBe(rewrite);
      expect(rewrite).not.toHaveBeenCalled();
      expect(result.instrumentationClientInject?.[0]).toBe('user.js');
      expect(result.turbopack?.rules?.['*.svg']).toBe(base.turbopack?.rules?.['*.svg']);
      expect(result.turbopack?.rules?.['*.js']).toEqual(
        expect.objectContaining({ condition: { not: 'foreign' } }),
      );
      expect(result.turbopack?.rules?.['*.tsx']).toEqual([
        expect.objectContaining({ condition: { not: 'foreign' } }),
        ...(Array.isArray(rule) ? rule : [rule]),
      ]);
      expect(base.instrumentationClientInject).toEqual(['user.js']);
      const entry = result.instrumentationClientInject?.[1];
      expect(entry).toBeDefined();
      const code = await readFile(join(root, entry ?? ''), 'utf8');
      expect(code).toContain('webpackIgnore: true');
      expect(code).toContain('turbopackIgnore: true');
      expect(code).toContain('http://127.0.0.1:4567');
      expect(code).not.toMatch(/document\.|setTimeout|setInterval/);
    }
    expect(nextModuleUrl).toHaveBeenCalledWith(root, 'http://localhost:3210');
  });

  it('calls user webpack first and keeps its rules and unrelated options', async () => {
    const userRule = { test: /custom/, use: ['custom-loader'] };
    const webpack = vi.fn(() => ({
      mode: 'development',
      module: { rules: [userRule], strictExportPresence: true },
    }));
    const result = await withMean({ webpack })('phase-development-server', context);
    const options = {} as Parameters<NonNullable<NextConfig['webpack']>>[1];
    const original = { plugins: [] };
    const configured: unknown = result.webpack?.(original, options);
    expect(webpack).toHaveBeenCalledWith(original, options);
    expect(configured).toEqual({
      mode: 'development',
      module: {
        strictExportPresence: true,
        rules: [expect.objectContaining({ enforce: 'pre', exclude: /node_modules/ }), userRule],
      },
    });
  });

  it('stamps ordinary Next JavaScript JSX and skips files without host JSX edits', () => {
    const code = 'export default function Page() { return <button>Save</button>; }';
    const result = stampJSX(code, join(root, 'app/page.js'), root);
    expect(result?.code).toContain(
      JSON.stringify(
        JSON.stringify({ file: 'app/page.js', line: 1, column: code.indexOf('<button') + 1 }),
      ),
    );
    expect(stampJSX('export const count = 1;', join(root, 'plain.js'), root)).toBeUndefined();
    expect(
      stampJSX('export default <Component />;', join(root, 'component.jsx'), root),
    ).toBeUndefined();
    expect(stampJSX(code, join(root, 'page.ts'), root)).toBeUndefined();
  });

  it('uses the shared JSX stamper and preserves unstamped input maps', () => {
    const callback = vi.fn();
    const loader = {
      resourcePath: join(root, 'src/SaveButton.tsx'),
      getOptions: () => ({ root }),
      callback,
    };
    stampLoader.call(loader, 'export function SaveButton() { return <button>Save</button>; }');
    expect(callback.mock.calls[0]?.[1]).toContain('data-mean-source');
    expect(callback.mock.calls[0]?.[1]).toContain('src/SaveButton.tsx');
    callback.mockClear();
    const map = { version: 3 };
    stampLoader.call(
      { ...loader, resourcePath: join(root, 'src/plain.js') },
      'export const x = 1',
      map,
    );
    expect(callback).toHaveBeenCalledWith(null, 'export const x = 1', map);
  });
});
