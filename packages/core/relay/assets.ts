import { access, readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page loads the bootstrap module, which imports the bundled runtime from the asset prefix.
export const BOOTSTRAP_PATH = '/__mean/runtime.js';
const ASSET_PREFIX = '/__mean/assets/';
const RUNTIME_PATH = `${ASSET_PREFIX}runtime.js`;
const ASSET_NAME = /^[a-zA-Z0-9_-]+\.js$/;

async function runtimeAssets(): Promise<Map<string, string>> {
  try {
    const directory = new URL('./browser/', import.meta.url);
    const files = await readdir(directory, { withFileTypes: true });
    return new Map(
      await Promise.all(
        files
          .filter((file) => file.isFile() && ASSET_NAME.test(file.name))
          .map(
            async (file) =>
              [file.name, await readFile(new URL(file.name, directory), 'utf8')] as const,
          ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Repository development only; published builds carry the bundled runtime.
    const source = new URL('../runtime/runtime.ts', import.meta.url);
    try {
      await access(source);
    } catch {
      throw new Error('Mean browser assets are missing; reinstall @meanhq/mean');
    }
    const { build } = await import('esbuild');
    const built = await build({
      entryPoints: [fileURLToPath(source)],
      bundle: true,
      splitting: true,
      outdir: 'browser',
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });
    return new Map(built.outputFiles.map((file) => [basename(file.path), file.text]));
  }
}

// Served without host transforms, so the module carries its own literal DEV guard.
export function bootstrapModule(
  token: string,
  root: string,
  lifecycle: string[] = [],
  socketOrigin?: string,
): string {
  return [
    `import { startRuntime } from ${JSON.stringify(RUNTIME_PATH)};`,
    'import.meta.env = { DEV: true };',
    "if (import.meta.env.DEV && typeof window !== 'undefined') {",
    `const runtime = startRuntime(${JSON.stringify(token)}, ${JSON.stringify(root)}${socketOrigin === undefined ? '' : `, new URL(import.meta.url, ${JSON.stringify(socketOrigin)}).origin`});`,
    ...lifecycle,
    '}',
    '',
  ].join('\n');
}

// origin is undefined until the relay is attached; authorize returns the page origin to allow cross-origin.
export interface RuntimeMiddlewareOptions {
  origin(): string | undefined;
  bootstrap(): string;
  authorize?: (req: IncomingMessage) => string | undefined;
  diagnostic?: (reason: string) => void;
}

export function runtimeMiddleware(
  options: RuntimeMiddlewareOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  let assets: Promise<Map<string, string>> | undefined;
  return (req, res, next) => {
    const origin = options.origin();
    const pathname = req.url?.split('?')[0];
    if (pathname !== BOOTSTRAP_PATH && !pathname?.startsWith(ASSET_PREFIX)) return next();
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const asset = pathname === BOOTSTRAP_PATH ? undefined : pathname.slice(ASSET_PREFIX.length);
    if (asset !== undefined && !ASSET_NAME.test(asset)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const pageOrigin = options.authorize?.(req);
    // Classic scripts arrive in no-cors mode, including cross-origin scripts.
    if (
      !origin ||
      req.method !== 'GET' ||
      req.headers.host !== new URL(origin).host ||
      req.headers['sec-fetch-mode'] !== 'cors' ||
      req.headers['sec-fetch-dest'] !== 'script' ||
      (options.authorize
        ? !pageOrigin
        : req.url !== pathname ||
          req.headers['sec-fetch-site'] !== 'same-origin' ||
          (req.headers.origin !== undefined && req.headers.origin !== origin))
    ) {
      options.diagnostic?.('page_rejected');
      res.statusCode = 403;
      res.end();
      return;
    }
    assets ??= runtimeAssets();
    void assets
      .then((files) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (pageOrigin) {
          res.setHeader('Access-Control-Allow-Origin', pageOrigin);
          res.setHeader('Vary', 'Origin, Referer');
        }
        if (asset === undefined) {
          res.end(options.bootstrap());
          return;
        }
        const code = files.get(asset);
        if (code === undefined) {
          res.removeHeader('Access-Control-Allow-Origin');
          res.statusCode = 404;
          res.end();
          return;
        }
        res.end(code);
      })
      .catch(() => {
        res.removeHeader('Access-Control-Allow-Origin');
        res.statusCode = 500;
        res.end();
      });
  };
}
