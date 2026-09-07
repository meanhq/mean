import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { validOrigin } from '../../core/relay/authentication.js';
import { isRecord } from '../../protocol/validation.js';
import { isMissing, nextCacheDirectory, nextModuleUrl } from './listener.js';

type ConfigContext = { defaultConfig: NextConfig };
type ConfigFunction = (phase: string, context: ConfigContext) => NextConfig | Promise<NextConfig>;
type Configuration = NextConfig | Promise<NextConfig> | ConfigFunction;
type Rules = NonNullable<NonNullable<NextConfig['turbopack']>['rules']>;
type Rule = Rules[string];

function prependRule(existing: Rule | undefined, loader: string, root: string): Rule {
  const stamp = {
    loaders: [{ loader, options: { root } }],
    condition: { not: 'foreign' as const },
  };
  if (!existing) return stamp;
  if (!Array.isArray(existing)) return [stamp, existing];
  return [stamp, ...existing];
}

// The client instrumentation injection this host relies on arrived in Next 16.3.
function isSupportedNextVersion(root: string): boolean {
  const require = createRequire(join(root, 'package.json'));
  const metadata: unknown = require('next/package.json');
  if (!isRecord(metadata) || typeof metadata.version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(metadata.version);
  return !!match && Number(match[1]) === 16 && Number(match[2]) >= 3;
}

function servedOrigin(): string | undefined {
  // Next 16.3.4 start-server.js:295-296 sets these after listening and before config load.
  const origin = process.env.__NEXT_PRIVATE_ORIGIN;
  if (!origin || !validOrigin(origin)) return;
  const url = new URL(origin);
  if (url.protocol !== 'http:' || (url.port || '80') !== process.env.PORT) return;
  return origin;
}

const warned = new Set<string>();
function diagnose(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`Mean Next disabled: ${reason}`);
}

export function withMean(configuration: Configuration = {}): ConfigFunction {
  return async (phase, context) => {
    const base = await (typeof configuration === 'function'
      ? configuration(phase, context)
      : configuration);
    if (phase !== 'phase-development-server') return base;
    const root = realpathSync(process.cwd());
    try {
      if (!isSupportedNextVersion(root)) {
        diagnose('requires Next 16.3 or later in the tested Next 16 series');
        return base;
      }
      const origin = servedOrigin();
      if (!origin) {
        diagnose('actual loopback HTTP page origin is unavailable; use stock next dev');
        return base;
      }
      if (base.basePath || base.assetPrefix) {
        diagnose('basePath and assetPrefix are not supported');
        return base;
      }
      const moduleUrl = await nextModuleUrl(root, origin);
      const injection = join(nextCacheDirectory(root), 'next-client.js');
      const code = [
        "if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {",
        `  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ${JSON.stringify(moduleUrl)}).catch(() => {});`,
        '}',
        '',
      ].join('\n');
      let previous: string | undefined;
      try {
        previous = readFileSync(injection, 'utf8');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (previous !== code) {
        const temporary = `${injection}.${randomUUID()}`;
        writeFileSync(temporary, code, { mode: 0o600 });
        renameSync(temporary, injection);
      }
      const loader = fileURLToPath(new URL('./jsx-loader.cjs', import.meta.url));
      const rules = base.turbopack?.rules ?? {};
      return {
        ...base,
        instrumentationClientInject: [
          ...(base.instrumentationClientInject ?? []),
          `./${relative(root, injection).replaceAll('\\', '/')}`,
        ],
        turbopack: {
          ...base.turbopack,
          rules: {
            ...rules,
            '*.js': prependRule(rules['*.js'], loader, root),
            '*.tsx': prependRule(rules['*.tsx'], loader, root),
            '*.jsx': prependRule(rules['*.jsx'], loader, root),
          },
        },
        webpack(config: unknown, options) {
          const configured: unknown = base.webpack ? base.webpack(config, options) : config;
          if (!isRecord(configured))
            throw new Error('Mean requires a webpack configuration object');
          const module = isRecord(configured.module) ? configured.module : {};
          return {
            ...configured,
            module: {
              ...module,
              rules: [
                {
                  test: /\.(?:jsx?|tsx)$/,
                  exclude: /node_modules/,
                  enforce: 'pre',
                  use: [{ loader, options: { root } }],
                },
                ...(Array.isArray(module.rules) ? module.rules : []),
              ],
            },
          };
        },
      };
    } catch {
      diagnose(
        'listener or installed Next metadata unavailable; check the project cache and restart next dev',
      );
      return base;
    }
  };
}
