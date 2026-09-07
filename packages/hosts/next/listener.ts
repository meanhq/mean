import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { validOrigin } from '../../core/relay/authentication.js';
import { startModuleRelay } from '../../core/relay/server.js';
import { isRecord, isUuid } from '../../protocol/validation.js';

// The process that started the project's relay, recorded in next-relay.json for other workers.
interface Owner {
  pid: number;
  instance: string;
  pageOrigin: string;
  moduleUrl: string;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readOwner(path: string): Owner | undefined {
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096
    )
      throw new Error('Mean Next listener lock requires a bounded private file owned by this user');
    const bytes = Buffer.alloc(4097);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error('Mean Next listener lock is oversized');
    text = bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isUuid(value.instance) ||
    typeof value.pageOrigin !== 'string' ||
    !validOrigin(value.pageOrigin) ||
    typeof value.moduleUrl !== 'string'
  )
    throw new Error('Invalid Mean Next listener lock');
  const url = new URL(value.moduleUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/__mean/runtime.js' ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get('token') ?? '') ||
    [...url.searchParams].length !== 1 ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Invalid Mean Next listener handoff');
  return {
    pid: value.pid,
    instance: value.instance,
    pageOrigin: value.pageOrigin,
    moduleUrl: value.moduleUrl,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function claim(path: string): (() => void) | undefined {
  try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
    return () => unlinkSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
}

export function nextCacheDirectory(root: string): string {
  const project = realpathSync(root);
  return join(
    project,
    'node_modules/.cache/mean',
    `next-${createHash('sha256').update(project).digest('hex')}`,
  );
}

// One relay per project: the first process to claim the guard starts it, later ones inherit its URL.
// A claim interrupted mid-write fails closed until next-relay.claim is removed by hand.
export async function nextModuleUrl(root: string, pageOrigin: string): Promise<string> {
  const directory = nextCacheDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Mean Next listener requires a private cache directory owned by this user');
  const lock = join(directory, 'next-relay.json');
  const guard = join(directory, 'next-relay.claim');
  const deadline = Date.now() + 5000;
  let release = claim(guard);
  while (!release) {
    if (Date.now() >= deadline)
      throw new Error(
        'Mean Next listener claim is busy; restart dev after removing a stale next-relay.claim',
      );
    await setTimeout(25);
    release = claim(guard);
  }
  try {
    const previous = readOwner(lock);
    if (previous && isAlive(previous.pid)) {
      if (previous.pageOrigin !== pageOrigin)
        throw new Error('Mean Next already serves another page origin for this project');
      const inherited = process.env.MEAN_NEXT_RELAY;
      if (inherited) {
        const handoff: unknown = JSON.parse(inherited);
        if (
          isRecord(handoff) &&
          handoff.root === root &&
          handoff.instance === previous.instance &&
          handoff.moduleUrl === previous.moduleUrl
        )
          return previous.moduleUrl;
      }
      process.env.MEAN_NEXT_RELAY = JSON.stringify({ root, ...previous });
      return previous.moduleUrl;
    }
    const relay = await startModuleRelay([pageOrigin], { projectRoot: root });
    const owner: Owner = {
      pid: process.pid,
      instance: randomUUID(),
      pageOrigin,
      moduleUrl: relay.moduleUrl,
    };
    try {
      const temporary = `${lock}.${owner.instance}`;
      writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
      renameSync(temporary, lock);
      process.env.MEAN_NEXT_RELAY = JSON.stringify({ root, ...owner });
    } catch (error) {
      await relay.close();
      throw error;
    }
    process.once('exit', () => {
      try {
        const unlock = claim(guard);
        if (!unlock) return;
        try {
          if (readOwner(lock)?.instance === owner.instance) unlinkSync(lock);
        } finally {
          unlock();
        }
      } catch {
        console.warn('Mean Next listener lock could not be cleaned; check the project cache');
      }
    });
    return owner.moduleUrl;
  } finally {
    release();
  }
}
