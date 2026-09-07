import { isBoundedString, isNumberWithin, isRecord } from './validation.js';

export interface Source {
  file: string;
  line: number;
  column?: number;
}
// Strips the project root lexically; nothing here touches the filesystem.
export function toProjectSource(value: unknown, projectRoot: string): Source | undefined {
  if (!isRecord(value) || typeof value.file !== 'string') return;
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  let file = value.file.replace(/\\/g, '/');
  if (root && file.startsWith(`${root}/`)) file = file.slice(root.length + 1);
  if (
    !isBoundedString(file, 1024) ||
    file.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(file) ||
    file.includes('\\') ||
    file.split('/').some((part) => part === '..' || part === '.' || part === '') ||
    !Number.isInteger(value.line) ||
    !isNumberWithin(value.line, 1, 1e7)
  )
    return;
  const source: Source = { file, line: value.line };
  if (value.column !== undefined) {
    if (!Number.isInteger(value.column) || !isNumberWithin(value.column, 1, 1e6)) return;
    source.column = value.column;
  }
  return source;
}
