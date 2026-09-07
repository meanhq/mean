import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectPageToken, projectRelayPort } from '../packages/core/relay/project-state.js';
import { startStandalone } from '../packages/hosts/standalone/standalone.js';

const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
function project(local = true): string {
  const root = mkdtempSync(join(tmpdir(), 'mean-project-state-'));
  roots.push(root);
  if (local) mkdirSync(join(root, 'node_modules'));
  return root;
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Transport and discovery', () => {
  it('persists a private per-project page token and rotates it only when requested', () => {
    const root = project();
    const token = projectPageToken(root);
    expect(projectPageToken(root)).toBe(token);
    const path = join(root, 'node_modules/.cache/mean/page-token');
    expect(readFileSync(path, 'utf8')).toBe(token);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(projectPageToken(root, true)).not.toBe(token);
    expect(projectPageToken(project())).not.toBe(token);
    chmodSync(path, 0o644);
    expect(() => projectPageToken(root)).toThrow();
  });

  it('publishes complete first-created state and preserves a concurrent process winner', async () => {
    const root = project();
    const ready = join(root, 'ready');
    const release = join(root, 'release');
    const module = new URL('../packages/core/relay/project-state.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { projectPageToken } from ${JSON.stringify(module)};
      const publish = fs.linkSync;
      fs.linkSync = (...args) => {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const deadline = Date.now() + 4000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw Error('Publication barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return publish(...args);
      };
      syncBuiltinESMExports();
      console.log(projectPageToken(${JSON.stringify(root)}));
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2000 });
      expect(existsSync(join(root, 'node_modules/.cache/mean/page-token'))).toBe(false);
      const winner = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import { projectPageToken } from ${JSON.stringify(module)};
        console.log(projectPageToken(${JSON.stringify(root)}));
      `,
        ],
        { timeout: 3000 },
      );
      const ended = once(child, 'exit');
      writeFileSync(release, 'go');
      expect((await ended)[0]).toBe(0);
      expect(output.trim()).toBe(winner.stdout.trim());
      expect(projectPageToken(root)).toBe(winner.stdout.trim());
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('uses a hashed home fallback without node_modules and refuses symlink tokens', () => {
    const home = project(false);
    vi.stubEnv('HOME', home);
    const root = project(false);
    const token = projectPageToken(root);
    const path = join(
      home,
      '.mean/relays',
      `${createHash('sha256').update(root).digest('hex')}.token`,
    );
    expect(readFileSync(path, 'utf8')).toBe(token);
    const target = join(home, 'target');
    writeFileSync(target, token, { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);
    expect(() => projectPageToken(root)).toThrow();
    expect(() => projectPageToken(root, true)).toThrow();
  });

  it('rejects invalid ports before writing project state', () => {
    const root = project();
    expect(() => projectRelayPort(root, NaN)).toThrow();
    expect(projectRelayPort(root)).toBeUndefined();
  });

  it('keeps the standalone tag stable, fails on port conflicts and changes it only explicitly', async () => {
    const root = project();
    vi.stubEnv('HOME', root);
    const origins = ['http://127.0.0.1:8000'];
    const first = await startStandalone(origins, { projectRoot: root });
    const tag = first.script;
    const port = Number(new URL(first.origin).port);
    await first.close();
    const second = await startStandalone(origins, { projectRoot: root });
    expect(second.script).toBe(tag);
    await second.close();
    const blocker = createServer();
    blocker.listen(port, '127.0.0.1');
    await once(blocker, 'listening');
    cleanup.push(() => new Promise<void>((done) => blocker.close(() => done())));
    const savedToken = projectPageToken(root);
    await expect(startStandalone(origins, { projectRoot: root })).rejects.toThrow(
      `Mean port ${port} is in use`,
    );
    await expect(
      startStandalone(origins, { projectRoot: root, rotateToken: true }),
    ).rejects.toThrow(`Mean port ${port} is in use`);
    expect(projectPageToken(root)).toBe(savedToken);
    expect(projectRelayPort(root)).toBe(port);
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    await new Promise<void>((done) => reservation.close(() => done()));
    const moved = await startStandalone(origins, { projectRoot: root, port: address.port });
    expect(projectRelayPort(root)).toBe(address.port);
    const token = new URL(moved.moduleUrl).searchParams.get('token');
    await moved.close();
    const rotated = await startStandalone(origins, { projectRoot: root, rotateToken: true });
    cleanup.push(rotated.close);
    expect(Number(new URL(rotated.origin).port)).toBe(address.port);
    expect(new URL(rotated.moduleUrl).searchParams.get('token')).not.toBe(token);
  });
});
