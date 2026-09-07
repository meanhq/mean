import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PAGE_TOKEN = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 64;

// Per-project state lives under node_modules/.cache/mean, or under ~/.mean/relays keyed by project path.
function statePath(root: string, kind: 'token' | 'port'): string {
  const project = resolve(root);
  let local = false;
  try {
    local = lstatSync(join(project, 'node_modules')).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = local
    ? join(project, 'node_modules/.cache/mean', `page-${kind}`)
    : join(
        homedir(),
        '.mean/relays',
        `${createHash('sha256').update(project).digest('hex')}.${kind}`,
      );
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Mean relay state requires a private directory owned by this user');
  return file;
}

function readState(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_STATE_BYTES
    )
      throw new Error('Mean relay state requires a bounded private file owned by this user');
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_STATE_BYTES) throw new Error('Mean relay state is oversized');
    return bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeState(path: string, value: string, replace: boolean): string {
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    if (replace) renameSync(temporary, path);
    else {
      // Publish only complete contents, without replacing a concurrent winner.
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readState(path);
        if (existing === undefined) throw new Error('Mean relay state changed during creation');
        return existing;
      }
    }
    return value;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function projectPageToken(root: string, rotate = false): string {
  const path = statePath(root, 'token');
  const existing = readState(path);
  if (!rotate && existing !== undefined && !PAGE_TOKEN.test(existing))
    throw new Error('Mean page token is invalid');
  const token =
    !rotate && existing !== undefined
      ? existing
      : writeState(path, randomBytes(32).toString('hex'), rotate);
  if (!PAGE_TOKEN.test(token)) throw new Error('Mean page token is invalid');
  return token;
}

export function projectRelayPort(
  root: string,
  chosen?: number,
  replace = false,
): number | undefined {
  if (chosen !== undefined && (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535))
    throw new Error('Mean relay port must be between 1024 and 65535');
  const path = statePath(root, 'port');
  const existing = readState(path);
  const value = chosen === undefined ? existing : writeState(path, String(chosen), replace);
  if (value === undefined) return;
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Mean relay port must be between 1024 and 65535');
  return port;
}
