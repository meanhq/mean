import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { BOOTSTRAP_PATH, bootstrapModule, runtimeMiddleware } from './assets.js';
import { matchesToken, validOrigin } from './authentication.js';
import { projectPageToken } from './project-state.js';
import { attach, PAGE_PATH } from './relay.js';

// The page origin a cross-origin module request belongs to, or undefined to refuse it.
// The bootstrap module must carry exactly the page token query; runtime assets carry none.
export function moduleOrigin(
  req: IncomingMessage,
  pageOrigins: readonly string[],
  token: string,
  relayOrigin: string,
): string | undefined {
  const origin = req.headers.origin;
  let referer: string | undefined;
  if (req.headers.referer !== undefined) {
    try {
      referer = new URL(req.headers.referer).origin;
    } catch {
      return;
    }
  }
  const url = req.url ?? '';
  const separator = url.indexOf('?');
  const pathname = separator < 0 ? url : url.slice(0, separator);
  const query = separator < 0 ? undefined : url.slice(separator + 1);
  const bootstrap = pathname === BOOTSTRAP_PATH;
  if (origin !== undefined && !pageOrigins.includes(origin)) return;
  if (referer !== undefined && referer !== origin) {
    // Dependency imports refer to their relay module, but still carry the page Origin.
    if (origin ? bootstrap || referer !== relayOrigin : !pageOrigins.includes(referer)) return;
  }
  const pageOrigin = origin ?? referer;
  if (!pageOrigin || !validOrigin(pageOrigin)) return;
  if (bootstrap) {
    const params = new URLSearchParams(query);
    if ([...params.keys()].length !== 1 || !matchesToken(params.get('token') ?? '', token)) return;
  } else if (query !== undefined) return;
  return pageOrigin;
}

export async function startModuleRelay(
  pageOrigins: readonly string[],
  options: {
    projectRoot?: string;
    discoveryFile?: string;
    port?: number;
    rotateToken?: boolean;
  } = {},
): Promise<{
  origin: string;
  moduleUrl: string;
  script: string;
  close(): Promise<void>;
}> {
  if (process.env.NODE_ENV === 'production') throw new Error('Mean is development only');
  if (!pageOrigins.length || !pageOrigins.every(validOrigin))
    throw new Error('Mean requires an explicit list of exact loopback HTTP or HTTPS page origins');
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
  )
    throw new Error('Mean relay port must be between 1024 and 65535');
  const allowed = [...pageOrigins];
  const server = createServer();
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const pageToken = projectPageToken(options.projectRoot ?? process.cwd(), options.rotateToken);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mean listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const relay = attach(server, {
      origin,
      pageOrigins: allowed,
      pageToken,
      ...(options.discoveryFile ? { discoveryFile: options.discoveryFile } : {}),
    });
    const moduleUrl = `${origin}${BOOTSTRAP_PATH}?token=${relay.pageToken}`;
    server.on('upgrade', (req, socket) => {
      if (req.url?.split('?')[0] !== PAGE_PATH)
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const middleware = runtimeMiddleware({
      origin: () => origin,
      bootstrap: () => bootstrapModule(relay.pageToken, options.projectRoot ?? '', [], origin),
      authorize: (req) => moduleOrigin(req, allowed, relay.pageToken, origin),
    });
    server.on('request', (req, res) =>
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    return {
      origin,
      moduleUrl,
      script: `<script type="module" referrerpolicy="no-referrer" src="${moduleUrl}"></script>`,
      close: () => {
        relay.dispose();
        return new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}
