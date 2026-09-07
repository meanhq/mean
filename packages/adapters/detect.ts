import { hasPrivateDescendants, isSkippedSubtree } from '../core/runtime/privacy.js';
import type { Adapter, Context } from './adapter.js';
import { react } from './react.js';
import { svelte } from './svelte.js';
import { vue } from './vue.js';

const MAX_SAMPLED_ELEMENTS = 128;
const MAX_DEPTH = 128;

// Detection order is also resolution order: the first adapter with any identity wins.
const candidates: Adapter[] = [react, vue, svelte];

// Samples a bounded preorder prefix of the document; a deeply nested root can be missed on purpose.
export function detectAdapters(context: Context): Adapter[] {
  const detected = new Set<Adapter>();
  const root = document.documentElement;
  const stack: { element: Element; depth: number }[] = root ? [{ element: root, depth: 0 }] : [];
  for (let sampled = 0; sampled < MAX_SAMPLED_ELEMENTS && stack.length; sampled++) {
    if (performance.now() >= context.deadline) {
      context.truncated = true;
      break;
    }
    const visit = stack.pop();
    if (!visit) break;
    const { element, depth } = visit;
    if (element.nextElementSibling) stack.push({ element: element.nextElementSibling, depth });
    if (isSkippedSubtree(element)) continue;
    if (!hasPrivateDescendants(element) && depth < MAX_DEPTH && element.firstElementChild)
      stack.push({ element: element.firstElementChild, depth: depth + 1 });
    for (const adapter of candidates) {
      if (detected.has(adapter)) continue;
      try {
        if (adapter.detect(element)) detected.add(adapter);
      } catch {
        /* A failing adapter leaves the page on the DOM lane. */
      }
    }
  }
  return candidates.filter((adapter) => detected.has(adapter));
}
