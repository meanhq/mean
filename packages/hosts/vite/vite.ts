import { randomBytes } from 'node:crypto';
import type { Plugin, ResolvedConfig } from 'vite';
import { BOOTSTRAP_PATH, bootstrapModule, runtimeMiddleware } from '../../core/relay/assets.js';
import { validOrigin } from '../../core/relay/authentication.js';
import { attach } from '../../core/relay/relay.js';
import { stampHTML } from '../../stampers/html/html.js';
import { stampSvelte } from '../../stampers/html/svelte.js';
import { stampVue } from '../../stampers/html/vue.js';
import { stampJSX } from '../../stampers/jsx/stamp.js';

export function mean(): Plugin {
  let config: ResolvedConfig;
  let active = false;
  let origin: string | undefined;
  let relay: ReturnType<typeof attach> | undefined;
  const pageToken = randomBytes(32).toString('hex');
  const reported = new Set<string>();
  const diagnostic = (reason: string) => {
    if (reason === 'absent' || reported.has(reason)) return;
    reported.add(reason);
    config.logger.warn(`Mean disconnected: ${reason}`);
  };

  return {
    name: 'mean-dom',
    apply: 'serve',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      active =
        config.command === 'serve' &&
        !config.isProduction &&
        config.mode !== 'test' &&
        !config.server.middlewareMode;
    },
    configureServer(server) {
      if (!active) return;
      if (!server.httpServer || server.config.server.middlewareMode) {
        active = false;
        return;
      }
      const httpServer = server.httpServer;

      // The real port is only known after listening; Vite may have moved off the requested one.
      const onListening = () => {
        const address = httpServer.address();
        if (!address || typeof address === 'string') return;
        const configuredHost =
          typeof config.server.host === 'string' ? config.server.host : 'localhost';
        const host = configuredHost === '::1' ? '[::1]' : configuredHost;
        const scheme = config.server.https ? 'https' : 'http';
        const port = address.port === (config.server.https ? 443 : 80) ? '' : `:${address.port}`;
        const pageOrigin = `${scheme}://${host}${port}`;
        if (!validOrigin(pageOrigin)) {
          config.logger.warn('Mean disabled: only loopback origins are supported');
          return;
        }
        try {
          relay = attach(httpServer, { origin: pageOrigin, pageToken, diagnostic });
          origin = pageOrigin;
        } catch {
          config.logger.warn('Mean disabled: a loopback-only listener is required');
        }
      };
      httpServer.once('listening', onListening);
      if (httpServer.listening) onListening();
      httpServer.once('close', () => {
        httpServer.off('listening', onListening);
        relay?.dispose();
        relay = undefined;
        origin = undefined;
      });

      server.middlewares.use(
        runtimeMiddleware({
          origin: () => origin,
          diagnostic,
          bootstrap: () =>
            bootstrapModule(pageToken, config.root, [
              `const { createHotContext } = await import(${JSON.stringify(`${config.base}@vite/client`)});`,
              `const hot = createHotContext(${JSON.stringify(BOOTSTRAP_PATH)});`,
              "hot.on('vite:ws:connect', () => runtime.reconnect());",
              'hot.dispose(() => runtime.dispose());',
            ]),
        }),
      );
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!active || !origin) return;
        return {
          html: stampHTML(html, context.filename, config.root)?.code ?? html,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'module', src: BOOTSTRAP_PATH, 'data-mean-runtime': '' },
              injectTo: 'head',
            },
          ],
        };
      },
    },
    transform: {
      order: 'pre',
      async handler(code, id) {
        if (!active) return;
        return (
          stampJSX(code, id, config.root) ??
          (await stampVue(code, id, config.root)) ??
          (await stampSvelte(code, id, config.root))
        );
      },
    },
    closeBundle() {
      relay?.dispose();
    },
  };
}
