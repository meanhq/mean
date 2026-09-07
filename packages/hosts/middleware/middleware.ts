import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { BOOTSTRAP_PATH, bootstrapModule, runtimeMiddleware } from '../../core/relay/assets.js';
import { validOrigin } from '../../core/relay/authentication.js';
import { attach } from '../../core/relay/relay.js';

export interface MeanOptions {
  dev: boolean;
  origin: string;
  root: string;
  discoveryFile?: string;
  diagnostic?: (reason: string) => void;
}

export interface MeanMiddleware {
  (request: IncomingMessage, response: ServerResponse, next: () => void): void;
  readonly scriptTag: string;
  dispose(): void;
}

export function mean(server: Server | Http2SecureServer, options: MeanOptions): MeanMiddleware {
  if (options.dev !== true || process.env.NODE_ENV === 'production') {
    return Object.assign(
      (_req: IncomingMessage, _res: ServerResponse, next: () => void) => next(),
      {
        scriptTag: '',
        dispose() {},
      },
    );
  }
  if (!validOrigin(options.origin)) throw new Error('Mean requires an exact loopback origin');
  let relay: ReturnType<typeof attach> | undefined;
  let disposed = false;
  const handler = runtimeMiddleware({
    origin: () => (relay ? options.origin : undefined),
    bootstrap: () => bootstrapModule(relay?.pageToken ?? '', options.root),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  });

  function onListening(): void {
    if (disposed || relay) return;
    const address = server.address();
    const url = new URL(options.origin);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!address || typeof address === 'string' || address.port !== port) {
      options.diagnostic?.('origin_mismatch');
      return;
    }
    try {
      relay = attach(server, {
        origin: options.origin,
        ...(options.discoveryFile ? { discoveryFile: options.discoveryFile } : {}),
        ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
      });
    } catch {
      options.diagnostic?.('listener_rejected');
    }
  }

  function dispose(): void {
    disposed = true;
    server.off('listening', onListening);
    server.off('close', dispose);
    relay?.dispose();
    relay = undefined;
  }

  server.once('listening', onListening);
  server.once('close', dispose);
  if (server.listening) onListening();
  return Object.defineProperties(handler, {
    scriptTag: {
      get: () =>
        relay ? `<script type="module" src="${BOOTSTRAP_PATH}" data-mean-runtime></script>` : '',
    },
    dispose: { value: dispose },
  }) as MeanMiddleware;
}
