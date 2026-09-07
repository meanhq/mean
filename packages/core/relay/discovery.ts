import {
  closeSync,
  constants,
  type FSWatcher,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  watch,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Endpoint {
  v: 1;
  port: number;
  instance: string;
  token: string;
}
export type Discovery =
  | { endpoint: Endpoint; reason?: never }
  | { endpoint?: never; reason: string };

const MAX_FILE_BYTES = 4096;
const COALESCE_MS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

export const discoveryPath = (): string => join(homedir(), '.mean', 'dom-endpoint.json');

// Accepts only a regular file owned by this user, mode 0600, in a 0700 directory, no symlinks.
export function readDiscovery(path: string = discoveryPath()): Discovery {
  let fd: number | undefined;
  try {
    const absolute = resolve(path);
    const directory = lstatSync(dirname(absolute));
    if (directory.isSymbolicLink() || lstatSync(absolute).isSymbolicLink())
      return { reason: 'symlink' };
    const uid = process.getuid?.();
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0)
      return { reason: 'unsafe_directory' };
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
      return { reason: 'unsafe_file' };
    if (stat.size > MAX_FILE_BYTES) return { reason: 'oversized' };
    // Read a bounded buffer even if another process grows the file after stat.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > MAX_FILE_BYTES) return { reason: 'oversized' };
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object') return { reason: 'invalid_data' };
    const fields = value as Record<string, unknown>;
    if (fields.v !== 1) return { reason: 'unsupported_version' };
    if (
      !Number.isInteger(fields.port) ||
      (fields.port as number) < 1024 ||
      (fields.port as number) > 65535 ||
      typeof fields.instance !== 'string' ||
      !UUID.test(fields.instance) ||
      typeof fields.token !== 'string' ||
      !TOKEN.test(fields.token)
    )
      return { reason: 'invalid_data' };
    // The file may name a port; it must never name where or what to connect to.
    if ('host' in fields || 'path' in fields || 'executable' in fields)
      return { reason: 'invalid_data' };
    return {
      endpoint: {
        v: 1,
        port: fields.port as number,
        instance: fields.instance,
        token: fields.token,
      },
    };
  } catch (error) {
    return {
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid_file',
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Watches the nearest existing ancestor directory and moves inward as directories appear.
export function watchDiscovery(
  onChange: (result: Discovery) => void,
  path: string = discoveryPath(),
): () => void {
  let watcher: FSWatcher | undefined;
  let watchedDirectory = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let verification: ReturnType<typeof setImmediate> | undefined;
  let closed = false;
  let lastSignature = '';

  const refresh = () => {
    if (closed) return;
    let directory = dirname(path);
    let directoryIdentity = '';
    while (true) {
      try {
        const stat = lstatSync(directory);
        if (stat.isDirectory()) {
          directoryIdentity = `${directory}:${stat.dev}:${stat.ino}`;
          break;
        }
      } catch {
        /* The parent may not exist yet. */
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (watchedDirectory !== directoryIdentity) {
      try {
        const replacement = watch(directory, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(refresh, COALESCE_MS);
        });
        replacement.on('error', () => {
          replacement.close();
          if (watcher === replacement) watchedDirectory = '';
        });
        watcher?.close();
        watcher = replacement;
        watchedDirectory = directoryIdentity;
        // Some native watchers miss writes in their registration tick. Recheck once, not on a loop.
        if (verification) clearImmediate(verification);
        verification = setImmediate(() => {
          verification = undefined;
          refresh();
        });
      } catch {
        /* An unreadable directory is reported by readDiscovery. */
      }
    }
    const result = readDiscovery(path);
    let revision = '';
    if (result.endpoint) {
      try {
        const stat = lstatSync(path);
        revision = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch {
        return;
      }
    }
    // Report each distinct file once, so an atomic replace with identical contents still counts.
    const signature = JSON.stringify(result) + revision;
    if (signature !== lastSignature) {
      lastSignature = signature;
      onChange(result);
    }
  };
  refresh();
  return () => {
    closed = true;
    watcher?.close();
    if (timer) clearTimeout(timer);
    if (verification) clearImmediate(verification);
  };
}
