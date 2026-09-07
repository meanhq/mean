import { createServer, get, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mean } from '../packages/hosts/middleware/middleware.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listening(host = '127.0.0.1'): Promise<{ server: Server; origin: string }> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

const headers = {
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'script',
  'sec-fetch-site': 'same-origin',
};

describe('Privacy and security', () => {
  it('requires explicit development and remains inert in production', async () => {
    for (const [dev, environment] of [
      [false, 'development'],
      [undefined, 'development'],
      [true, 'production'],
    ] as const) {
      vi.stubEnv('NODE_ENV', environment);
      const { server, origin } = await listening();
      const middleware = mean(server, { dev: dev as boolean, origin, root: process.cwd() });
      server.on('request', (req, res) =>
        middleware(req, res, () => {
          res.statusCode = 404;
          res.end();
        }),
      );
      expect(middleware.scriptTag).toBe('');
      expect(server.listenerCount('upgrade')).toBe(0);
      expect((await fetch(`${origin}/__mean/runtime.js`, { headers })).status).toBe(404);
      middleware.dispose();
    }
  });

  it('uses shared module checks and disposes its relay', async () => {
    const { server, origin } = await listening();
    const middleware = mean(server, { dev: true, origin, root: process.cwd() });
    server.on('request', (req, res) =>
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    expect(middleware.scriptTag).toContain('type="module"');
    const response = await fetch(`${origin}/__mean/runtime.js`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.text()).not.toContain('@vite/client');
    expect((await fetch(`${origin}/__mean/runtime.js`)).status).toBe(403);
    expect(
      (
        await fetch(`${origin}/__mean/runtime.js`, {
          headers: { ...headers, origin: 'http://localhost:1' },
        })
      ).status,
    ).toBe(403);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(
        `${origin}/__mean/runtime.js`,
        { headers: { ...headers, host: 'localhost:1' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    });
    expect(wrongHostStatus).toBe(403);
    middleware.dispose();
    middleware.dispose();
    expect(middleware.scriptTag).toBe('');
    expect(server.listenerCount('upgrade')).toBe(0);
    expect((await fetch(`${origin}/__mean/runtime.js`, { headers })).status).toBe(403);
  });

  it('refuses wildcard listeners and mismatched actual ports', async () => {
    const { server, origin } = await listening('0.0.0.0');
    const diagnostic = vi.fn();
    const wildcard = mean(server, { dev: true, origin, root: '.', diagnostic });
    expect(wildcard.scriptTag).toBe('');
    expect(diagnostic).toHaveBeenCalledWith('listener_rejected');
    wildcard.dispose();
    const mismatch = mean(server, {
      dev: true,
      origin: 'http://127.0.0.1:1',
      root: '.',
      diagnostic,
    });
    expect(mismatch.scriptTag).toBe('');
    expect(diagnostic).toHaveBeenCalledWith('origin_mismatch');
    mismatch.dispose();
    expect(() => mean(server, { dev: true, origin: 'http://example.com', root: '.' })).toThrow();
  });
});

describe('Transport and discovery', () => {
  it('mounts before listening and removes pending listeners on disposal', async () => {
    const server = createServer();
    servers.push(server);
    const before = server.listenerCount('listening');
    const middleware = mean(server, { dev: true, origin: 'http://127.0.0.1:1234', root: '.' });
    expect(middleware.scriptTag).toBe('');
    expect(server.listenerCount('listening')).toBe(before + 1);
    middleware.dispose();
    expect(server.listenerCount('listening')).toBe(before);
  });
});
