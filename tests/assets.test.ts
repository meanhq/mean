import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { bootstrapModule, runtimeMiddleware } from '../packages/core/relay/assets.js';

describe('Transport and discovery', () => {
  it('serves authenticated browser modules on an HTTP server without a host framework', async () => {
    let origin: string | undefined;
    const middleware = runtimeMiddleware({
      origin: () => origin,
      bootstrap: () => bootstrapModule('page-token', '/project'),
    });
    const server = createServer((req, res) =>
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      origin = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${origin}/unrelated`)).status).toBe(404);
      expect((await fetch(`${origin}/__mean/runtime.js`)).status).toBe(403);
      const headers = {
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'script',
        'sec-fetch-site': 'same-origin',
      };
      const bootstrap = await fetch(`${origin}/__mean/runtime.js`, { headers });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get('cache-control')).toBe('no-store');
      expect(bootstrap.headers.get('access-control-allow-origin')).toBeNull();
      expect(await bootstrap.text()).toBe(bootstrapModule('page-token', '/project'));
      expect(bootstrapModule('page-token', '/project')).not.toContain('vite');
      const runtime = await fetch(`${origin}/__mean/assets/runtime.js`, { headers });
      expect(runtime.status).toBe(200);
      expect(await runtime.text()).toContain('startRuntime');
      expect((await fetch(`${origin}/__mean/runtime.js?token=wrong`, { headers })).status).toBe(
        403,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
