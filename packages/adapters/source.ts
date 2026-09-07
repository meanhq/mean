import { type Source, toProjectSource } from '../protocol/source.js';
import type { Context } from './adapter.js';

export function readSourceStamp(element: Element, context: Context): Source | undefined {
  const stamp = element.getAttribute('data-mean-source');
  if (!stamp) return;
  if (stamp.length > 4096) {
    context.truncated = true;
    return;
  }
  try {
    const source = toProjectSource(JSON.parse(stamp), context.projectRoot);
    if (!source) context.truncated = true;
    return source;
  } catch {
    // Malformed metadata is absent evidence, not a reason to stop walking.
    return;
  }
}
