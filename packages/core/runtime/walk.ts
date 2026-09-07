import type { Adapter, Context, Identity } from '../../adapters/adapter.js';
import { readSourceStamp } from '../../adapters/source.js';
import { codePointCount, isBoundedString, utf8Length } from '../../protocol/validation.js';
import { hasPrivateDescendants, isSkippedSubtree } from './privacy.js';
import type { Viewport } from './viewport.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Entry extends Identity {
  rect: Rect;
  tag: string;
  classes: string[];
  framework: string;
  depth: number;
  role?: string;
  id?: string;
  text?: string;
  elementPath?: string;
}
export interface WalkResult {
  v: 1;
  type: 'walk.result';
  requestId: string;
  viewport: Viewport;
  elements: Entry[];
  truncated: boolean;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// One pending node on the traversal stack, with the rectangular clip its ancestors established.
interface Visit {
  node: Node;
  depth: number;
  clip: Bounds;
  path?: string;
  siblings: Map<string, number>;
}

const MAX_ELEMENTS = 1000;
const MAX_VISITED = 10000;
const MAX_DEPTH = 128;
const MAX_BYTES = 256 * 1024;
const MAX_PATH_DEPTH = 12;
const MAX_TEXT = 80;
const MAX_CLASSES = 16;
const TEXT_CHUNK = 1024;

const intersection = (a: Bounds, b: Bounds): Bounds => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
const positive = (r: Bounds): boolean => r.right > r.left && r.bottom > r.top;
const clips = (overflow: string): boolean => /^(hidden|clip|scroll|auto)$/.test(overflow);

export function walk(
  requestId: string,
  view: Viewport,
  adapters: Adapter[],
  context: Context,
): WalkResult {
  const result: WalkResult = {
    v: 1,
    type: 'walk.result',
    requestId,
    viewport: view,
    elements: [],
    truncated: context.truncated,
  };
  const root = document.documentElement;
  if (!root) return result;
  const stack: Visit[] = [
    {
      node: root,
      depth: 0,
      clip: { left: 0, top: 0, right: view.width, bottom: view.height },
      siblings: new Map(),
    },
  ];
  let visited = 0;
  let bytes = utf8Length(JSON.stringify(result));
  const pastDeadline = () => performance.now() >= context.deadline;

  // Oversized identity fields are omitted, never shortened into a different identity.
  const keepWithin = (value: string | null, maxCodePoints: number): string | undefined => {
    if (!value) return undefined;
    if (isBoundedString(value, maxCodePoints)) return value;
    context.truncated = true;
    return undefined;
  };

  // Direct text nodes only, whitespace collapsed, cut at a code point boundary at 80.
  const directText = (element: Element, clip: Bounds): string | undefined => {
    let text = '';
    const done = () => text.trim() || undefined;
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (++visited >= MAX_VISITED || pastDeadline()) {
        context.truncated = true;
        break;
      }
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      let visible = false;
      for (const rect of range.getClientRects()) {
        if (pastDeadline()) {
          context.truncated = true;
          return done();
        }
        if (positive(intersection(rect, clip))) {
          visible = true;
          break;
        }
      }
      if (!visible) continue;
      const textNode = child as Text;
      for (let offset = 0; offset < textNode.length; ) {
        if (pastDeadline()) {
          context.truncated = true;
          return done();
        }
        let chunk = textNode.substringData(offset, TEXT_CHUNK);
        const last = chunk.charCodeAt(chunk.length - 1);
        // Do not split a surrogate pair at a chunk boundary.
        if (last >= 0xd800 && last <= 0xdbff && offset + chunk.length < textNode.length)
          chunk += textNode.substringData(offset + chunk.length, 1);
        offset += chunk.length;
        text = (text + chunk).replace(/\s+/g, ' ').trimStart();
        if (codePointCount(text) > MAX_TEXT) {
          text = Array.from(text).slice(0, MAX_TEXT).join('');
          context.truncated = true;
          return done();
        }
      }
    }
    return done();
  };

  const resolveIdentity = (element: Element, entry: Entry): void => {
    for (const adapter of adapters) {
      if (pastDeadline()) {
        context.truncated = true;
        break;
      }
      try {
        const identity = adapter.resolve(element, context);
        if (identity.component || identity.source) {
          Object.assign(entry, identity);
          entry.framework = adapter.id;
          break;
        }
      } catch {
        /* Metadata failures leave the element on the DOM lane. */
      }
    }
    if (!entry.source && !pastDeadline()) {
      const source = readSourceStamp(element, context);
      if (source) entry.source = source;
    }
  };

  while (stack.length) {
    if (visited >= MAX_VISITED || result.elements.length >= MAX_ELEMENTS || pastDeadline()) {
      context.truncated = true;
      break;
    }
    const visit = stack.pop();
    if (!visit) break;
    const node = visit.node;
    // Push one sibling at a time: a huge child list cannot allocate an unbounded stack.
    if (node.nextSibling) stack.push({ ...visit, node: node.nextSibling });
    visited++;
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    const siblingType = `${element.namespaceURI}:${element.localName}`;
    const ordinal = (visit.siblings.get(siblingType) || 0) + 1;
    visit.siblings.set(siblingType, ordinal);
    if (isSkippedSubtree(element)) continue;

    const style = getComputedStyle(element);
    if (style.display === 'none' || (style.opacity !== '' && Number(style.opacity) === 0)) continue;
    // Nonrectangular clips cannot be represented by this protocol.
    if (
      (style.clipPath && style.clipPath !== 'none') ||
      (style.clip && style.clip !== 'auto') ||
      (style.maskImage && style.maskImage !== 'none')
    )
      continue;

    const clientRect = element.getBoundingClientRect();
    const box = intersection(clientRect, visit.clip);
    let childClip = visit.clip;
    const clipX = style.display !== 'inline' && clips(style.overflowX || style.overflow);
    const clipY = style.display !== 'inline' && clips(style.overflowY || style.overflow);
    if (clipX || clipY) {
      // Transformed or rounded overflow containers clip to a shape this protocol cannot express.
      if ((style.transform && style.transform !== 'none') || parseFloat(style.borderRadius) > 0)
        continue;
      const padding = {
        left: clientRect.left + element.clientLeft,
        top: clientRect.top + element.clientTop,
        right: clientRect.left + element.clientLeft + element.clientWidth,
        bottom: clientRect.top + element.clientTop + element.clientHeight,
      };
      childClip = intersection(visit.clip, {
        left: clipX ? padding.left : -Infinity,
        right: clipX ? padding.right : Infinity,
        top: clipY ? padding.top : -Infinity,
        bottom: clipY ? padding.bottom : Infinity,
      });
    }

    const isPrivate = hasPrivateDescendants(element);
    const id = keepWithin(element.getAttribute('id'), 128);
    const classes: string[] = [];
    let classCount = 0;
    for (const token of element.classList) {
      if (++classCount > MAX_CLASSES) {
        context.truncated = true;
        break;
      }
      const valid = keepWithin(token, 128);
      if (valid) classes.push(valid);
    }

    let path: string | undefined;
    if (
      visit.depth < MAX_PATH_DEPTH &&
      (visit.depth === 0 || visit.path) &&
      typeof CSS !== 'undefined' &&
      CSS.escape
    ) {
      const literalId = element.getAttribute('id');
      // An omitted oversized id must not turn into a class-based selector for a different element.
      if ((!literalId || id) && tag.length <= 64) {
        const selector = id
          ? `#${CSS.escape(id)}`
          : classes
              .slice(0, 2)
              .map((token) => `.${CSS.escape(token)}`)
              .join('');
        const segment = `${element.localName}${selector}:nth-of-type(${ordinal})`;
        path = keepWithin(visit.path ? `${visit.path} > ${segment}` : segment, 1024);
      }
    } else if (visit.depth >= MAX_PATH_DEPTH) context.truncated = true;

    if (!isPrivate && element.firstChild && positive(childClip)) {
      if (visit.depth < MAX_DEPTH)
        stack.push({
          node: element.firstChild,
          depth: visit.depth + 1,
          clip: childClip,
          ...(path ? { path } : {}),
          siblings: new Map(),
        });
      else context.truncated = true;
    }

    if (!positive(box) || style.visibility === 'hidden' || style.visibility === 'collapse')
      continue;
    if (!isBoundedString(tag, 64)) {
      context.truncated = true;
      continue;
    }
    const entry: Entry = {
      rect: {
        x: box.left / view.width,
        y: box.top / view.height,
        width: (box.right - box.left) / view.width,
        height: (box.bottom - box.top) / view.height,
      },
      tag,
      classes,
      framework: 'dom',
      depth: visit.depth,
    };
    if (id) entry.id = id;
    const role = keepWithin(element.getAttribute('role')?.trim().split(/\s+/)[0] || null, 64);
    if (role) entry.role = role;
    if (path) entry.elementPath = path;
    if (!isPrivate) {
      const text = directText(element, intersection(box, childClip));
      if (text) entry.text = text;
    }
    resolveIdentity(element, entry);

    const size = utf8Length(JSON.stringify(entry)) + 1;
    if (bytes + size > MAX_BYTES) {
      context.truncated = true;
      break;
    }
    bytes += size;
    result.elements.push(entry);
  }

  result.truncated = context.truncated;
  // Trim the traversal prefix before sorting, never the hit-test order.
  while (utf8Length(JSON.stringify(result)) > MAX_BYTES) {
    result.elements.pop();
    result.truncated = true;
  }
  // Deepest first, then smallest: Mean's hit-test precedence.
  result.elements.sort(
    (a, b) => b.depth - a.depth || a.rect.width * a.rect.height - b.rect.width * b.rect.height,
  );
  return result;
}
