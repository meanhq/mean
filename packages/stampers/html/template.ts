import { relative } from 'node:path';
import type MagicString from 'magic-string';
import { toProjectSource } from '../../protocol/source.js';

export const STAMP_ATTRIBUTE = 'data-mean-source';

// The project-relative POSIX path a stamp carries, or undefined for dependencies and files outside the root.
export function projectSourceFile(filename: string, root: string): string | undefined {
  if (filename.includes('/node_modules/')) return;
  const file = relative(root, filename).replaceAll('\\', '/');
  return toProjectSource({ file, line: 1 }, '')?.file;
}

export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

// Returns a function that stamps the element opening at `start`, inserting before `openingEnd`.
export function createTemplateStamper(
  edited: MagicString,
  code: string,
  file: string,
  expression: boolean,
): (start: number, openingEnd: number) => void {
  const lines = [0];
  for (const match of code.matchAll(/\n/g)) lines.push(match.index + 1);
  return (start, openingEnd) => {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((lines[middle] ?? Infinity) <= start) low = middle;
      else high = middle;
    }
    const stamp = JSON.stringify({ file, line: low + 1, column: start - (lines[low] ?? 0) + 1 });
    const value = expression ? `{${JSON.stringify(stamp)}}` : `"${escapeAttribute(stamp)}"`;
    edited.appendLeft(openingEnd, ` ${STAMP_ATTRIBUTE}=${value}`);
  };
}
