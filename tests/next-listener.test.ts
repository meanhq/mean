import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextCacheDirectory, nextModuleUrl } from '../packages/hosts/next/listener.js';

interface Worker {
  child: ChildProcess;
  result: Promise<{ moduleUrl: string; handoff: string; pid: number }>;
}

function worker(script: string, root: string, handoff?: string): Worker {
  const child = spawn(process.execPath, ['--import', 'tsx', script, root], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ...(handoff ? { MEAN_NEXT_RELAY: handoff } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = new Promise<{ moduleUrl: string; handoff: string; pid: number }>(
    (done, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error(`Next worker timed out: ${errors}`)), 10_000);
      child.stderr?.on('data', (data) => {
        errors += String(data);
      });
      child.once('error', reject);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Next worker exited: ${errors}`));
      });
      child.stdout?.on('data', (data) => {
        output += String(data);
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try {
          done(JSON.parse(output.slice(0, output.indexOf('\n'))));
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  return { child, result };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin?.end('exit\n');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

describe('Transport and discovery: Next listener ownership', () => {
  it('rejects unsafe owner files before trusting a listener handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mean-next-lock-auth-'));
    const directory = nextCacheDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'next-relay.json');
    const owner = {
      pid: process.pid,
      instance: randomUUID(),
      pageOrigin: 'http://localhost:3210',
      moduleUrl: `http://127.0.0.1:4567/__mean/runtime.js?token=${'a'.repeat(64)}`,
    };
    try {
      await writeFile(lock, JSON.stringify(owner), { mode: 0o644 });
      await expect(nextModuleUrl(root, owner.pageOrigin)).rejects.toThrow('private file');
      await chmod(lock, 0o600);
      for (const invalid of [
        ' '.repeat(4097),
        JSON.stringify({ ...owner, instance: 'not-a-uuid' }),
        JSON.stringify({ ...owner, pageOrigin: 'http://foreign.test' }),
      ]) {
        await writeFile(lock, invalid);
        await expect(nextModuleUrl(root, owner.pageOrigin)).rejects.toThrow();
      }
      await unlink(lock);
      const target = join(root, 'owner.json');
      await writeFile(target, JSON.stringify(owner), { mode: 0o600 });
      await symlink(target, lock);
      await expect(nextModuleUrl(root, owner.pageOrigin)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gives projects sharing node_modules separate lock and injection directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mean-next-shared-'));
    try {
      const shared = join(root, 'shared');
      await mkdir(shared);
      const projects = [join(root, 'one'), join(root, 'two')];
      for (const project of projects) {
        await mkdir(project);
        await symlink(shared, join(project, 'node_modules'));
      }
      expect(new Set(projects.map(nextCacheDirectory)).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares one listener across concurrent evaluations and inherited worker environments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mean-next-owner-'));
    const script = join(root, 'worker.mjs');
    await writeFile(
      script,
      `import { nextModuleUrl } from ${JSON.stringify(resolve('packages/hosts/next/listener.ts'))};\nconst moduleUrl = await nextModuleUrl(process.argv[2], 'http://localhost:3210');\nconsole.log(JSON.stringify({moduleUrl, handoff:process.env.MEAN_NEXT_RELAY,pid:process.pid}));\nprocess.stdin.on('data', () => process.exit(0));\nprocess.stdin.resume();\n`,
    );
    const workers: Worker[] = [];
    try {
      for (let index = 0; index < 6; index++) workers.push(worker(script, root));
      const results = await Promise.all(workers.map((item) => item.result));
      expect(new Set(results.map((result) => result.moduleUrl)).size).toBe(1);
      const first = results[0];
      if (!first) throw new Error('No Next worker result');
      const lockPath = join(nextCacheDirectory(root), 'next-relay.json');
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
        pid: number;
        instance: string;
      };
      const inherited = worker(script, root, first.handoff);
      workers.push(inherited);
      expect((await inherited.result).moduleUrl).toBe(first.moduleUrl);
      await stop(inherited.child);
      expect(JSON.parse(await readFile(lockPath, 'utf8')).instance).toBe(owner.instance);
      const ownerWorker = workers.find((item) => item.child.pid === owner.pid);
      if (!ownerWorker) throw new Error('Owner worker not found');
      await stop(ownerWorker.child);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const replacement = worker(script, root);
      workers.push(replacement);
      const next = await replacement.result;
      expect(new URL(next.moduleUrl).hostname).toBe('127.0.0.1');
      expect(new URL(next.moduleUrl).searchParams.get('token')).toBe(
        new URL(first.moduleUrl).searchParams.get('token'),
      );
      for (const item of workers) if (item !== replacement) await stop(item.child);
      expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(replacement.child.pid);
    } finally {
      await Promise.all(workers.map((item) => stop(item.child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reclaims a dead owner and never deletes a replacement owner on exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mean-next-stale-'));
    const script = join(root, 'worker.mjs');
    const directory = nextCacheDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'next-relay.json');
    await writeFile(
      lock,
      JSON.stringify({
        pid: 2147483647,
        instance: randomUUID(),
        pageOrigin: 'http://localhost:3210',
        moduleUrl: `http://127.0.0.1:4567/__mean/runtime.js?token=${'a'.repeat(64)}`,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      script,
      `import { nextModuleUrl } from ${JSON.stringify(resolve('packages/hosts/next/listener.ts'))};\nconst moduleUrl = await nextModuleUrl(process.argv[2], 'http://localhost:3210');\nconsole.log(JSON.stringify({moduleUrl,handoff:process.env.MEAN_NEXT_RELAY,pid:process.pid}));\nprocess.stdin.on('data', () => process.exit(0));\nprocess.stdin.resume();\n`,
    );
    const current = worker(script, root);
    try {
      await current.result;
      const owner = JSON.parse(await readFile(lock, 'utf8'));
      expect(owner.pid).toBe(current.child.pid);
      const replacement = { ...owner, pid: process.pid, instance: randomUUID() };
      await writeFile(lock, JSON.stringify(replacement));
      await stop(current.child);
      expect(JSON.parse(await readFile(lock, 'utf8'))).toEqual(replacement);
    } finally {
      await stop(current.child);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
