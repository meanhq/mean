import type { Adapter, Context, Identity } from '../../adapters/adapter.js';
import { readSourceStamp } from '../../adapters/source.js';
import { MeanProtocolError } from '../../protocol/requests.js';
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
export interface WalkPart {
  v: 1;
  type: 'walk.result';
  requestId: string;
  viewport: Viewport;
  elements: Entry[];
  truncated: boolean;
  part: number;
  more: boolean;
}

// One walk, resumed slice by slice from the same traversal stack. Spec: Walk algorithm and budget.
export interface Traversal {
  readonly requestId: string;
  // Continues until the deadline, a part cap or the end of the document; the part is the caller's to send.
  slice(deadline: number): WalkPart;
  // Ends an unfinished walk early: whatever is buffered leaves as the final, truncated part.
  cancel(): WalkPart;
  // The wire form of a part from this walk. Entries were encoded once while
  // the byte budget was counted; the part is joined from those strings, so
  // the work after the deadline is a join, not a second encoding.
  serialize(part: WalkPart): string;
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

const MAX_ELEMENTS = 4000;
const MAX_PART_ELEMENTS = 1000;
const MAX_VISITED = 40000;
const MAX_DEPTH = 128;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PART_BYTES = 256 * 1024;
const MAX_PARTS = 1000;
const MAX_PATH_LENGTH = 4096;
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
const area = (entry: Entry): number => entry.rect.width * entry.rect.height;
// Largest corner radius in CSS pixels. The shorthand alone misses corners after a zero first value;
// the longhands alone miss engines that only serialise the shorthand. Percentages resolve against the
// larger box side, which keeps the inset conservative.
const largestRadius = (style: CSSStyleDeclaration, width: number, height: number): number => {
  let largest = 0;
  for (const value of [
    style.borderRadius,
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]) {
    for (const token of value.split(/[\s/]+/)) {
      const number = parseFloat(token);
      if (!Number.isFinite(number)) continue;
      const pixels = token.endsWith('%') ? (number / 100) * Math.max(width, height) : number;
      if (pixels > largest) largest = pixels;
    }
  }
  return largest;
};

export function startWalk(
  requestId: string,
  view: Viewport,
  adapters: Adapter[],
  context: Context,
): Traversal {
  const root = document.documentElement;
  const stack: Visit[] = root
    ? [
        {
          node: root,
          depth: 0,
          clip: { left: 0, top: 0, right: view.width, bottom: view.height },
          siblings: new Map(),
        },
      ]
    : [];
  let visited = 0;
  let emitted = 0;
  let parts = 0;
  let finished = false;
  // An entry that did not fit the closing part opens the next one.
  let carried: { entry: Entry; size: number } | undefined;
  const part = (elements: Entry[], more: boolean, number: number): WalkPart => ({
    v: 1,
    type: 'walk.result',
    requestId,
    viewport: view,
    elements,
    truncated: more ? false : context.truncated,
    part: number,
    more,
  });
  // Every part carries the envelope; the widest part number and truncated value are assumed.
  const envelopeBytes = utf8Length(JSON.stringify(part([], false, MAX_PARTS)));
  const encoded = new WeakMap<Entry, string>();
  // The envelope up to the elements array, in the key order `part` writes.
  const head = JSON.stringify({ v: 1, type: 'walk.result', requestId, viewport: view }).slice(
    0,
    -1,
  );
  const serialize = (value: WalkPart): string => {
    const items = value.elements.map((entry) => encoded.get(entry) ?? JSON.stringify(entry));
    return `${head},"elements":[${items.join(',')}],"truncated":${value.truncated},"part":${value.part},"more":${value.more}}`;
  };
  let totalBytes = envelopeBytes;
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
    if (!entry.source) {
      const source = readSourceStamp(element, context);
      if (source) entry.source = source;
    }
  };

  // Visits one stack node; returns the entry it produced, if any.
  const inspect = (): Entry | undefined => {
    const visit = stack.pop();
    if (!visit) return;
    const node = visit.node;
    // Push one sibling at a time: a huge child list cannot allocate an unbounded stack.
    if (node.nextSibling) stack.push({ ...visit, node: node.nextSibling });
    visited++;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    const siblingType = `${element.namespaceURI}:${element.localName}`;
    const ordinal = (visit.siblings.get(siblingType) || 0) + 1;
    visit.siblings.set(siblingType, ordinal);
    if (isSkippedSubtree(element)) return;

    const style = getComputedStyle(element);
    if (style.display === 'none' || (style.opacity !== '' && Number(style.opacity) === 0)) return;
    // Nonrectangular clips cannot be represented by this protocol.
    if (
      (style.clipPath && style.clipPath !== 'none') ||
      (style.clip && style.clip !== 'auto') ||
      (style.maskImage && style.maskImage !== 'none')
    )
      return;

    const clientRect = element.getBoundingClientRect();
    const box = intersection(clientRect, visit.clip);
    let childClip = visit.clip;
    // The element's own box is clipped by its ancestors only; its overflow clips descendants.
    let descend = true;
    const clipX = style.display !== 'inline' && clips(style.overflowX || style.overflow);
    const clipY = style.display !== 'inline' && clips(style.overflowY || style.overflow);
    if (clipX || clipY) {
      // A transformed overflow container clips to a shape this protocol cannot express.
      if (style.transform && style.transform !== 'none') descend = false;
      else {
        // A rounded container clips to its padding box inset by its largest corner radius.
        const inset = largestRadius(style, element.clientWidth, element.clientHeight);
        const padding = {
          left: clientRect.left + element.clientLeft + inset,
          top: clientRect.top + element.clientTop + inset,
          right: clientRect.left + element.clientLeft + element.clientWidth - inset,
          bottom: clientRect.top + element.clientTop + element.clientHeight - inset,
        };
        childClip = intersection(visit.clip, {
          left: clipX ? padding.left : -Infinity,
          right: clipX ? padding.right : Infinity,
          top: clipY ? padding.top : -Infinity,
          bottom: clipY ? padding.bottom : Infinity,
        });
      }
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

    // Every walked element carries its full path: a cut path would read
    // as a real one and collide with its neighbours.
    let path: string | undefined;
    if ((visit.depth === 0 || visit.path) && typeof CSS !== 'undefined' && CSS.escape) {
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
        path = keepWithin(visit.path ? `${visit.path} > ${segment}` : segment, MAX_PATH_LENGTH);
      }
    }

    if (descend && !isPrivate && element.firstChild && positive(childClip)) {
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

    if (!positive(box) || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    if (!isBoundedString(tag, 64)) {
      context.truncated = true;
      return;
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
    return entry;
  };

  const finish = (): void => {
    finished = true;
    stack.length = 0;
    carried = undefined;
  };

  const close = (elements: Entry[], more: boolean): WalkPart => {
    if (!more) finish();
    // Deepest first, then smallest: Mean's hit-test precedence. A stable sort keeps traversal order.
    elements.sort((a, b) => b.depth - a.depth || area(a) - area(b));
    return part(elements, more, ++parts);
  };

  // Ends a part with more to come and books the next part's envelope; the last permitted part closes.
  const yieldPart = (elements: Entry[]): WalkPart => {
    if (parts + 1 >= MAX_PARTS) {
      context.truncated = true;
      return close(elements, false);
    }
    totalBytes += envelopeBytes;
    return close(elements, true);
  };

  const assertOpen = (): void => {
    if (finished) throw new MeanProtocolError('internal');
  };

  return {
    requestId,
    slice(deadline) {
      assertOpen();
      const elements: Entry[] = [];
      let partBytes = envelopeBytes;
      if (carried) {
        elements.push(carried.entry);
        partBytes += carried.size;
        carried = undefined;
      }
      while (stack.length) {
        if (performance.now() >= deadline) return yieldPart(elements);
        if (visited >= MAX_VISITED || emitted >= MAX_ELEMENTS || pastDeadline()) {
          context.truncated = true;
          break;
        }
        const entry = inspect();
        if (!entry) continue;
        const json = JSON.stringify(entry);
        encoded.set(entry, json);
        const size = utf8Length(json) + 1;
        const splits = elements.length >= MAX_PART_ELEMENTS || partBytes + size > MAX_PART_BYTES;
        if (totalBytes + size + (splits ? envelopeBytes : 0) > MAX_BYTES) {
          context.truncated = true;
          break;
        }
        totalBytes += size;
        emitted++;
        if (splits) {
          carried = { entry, size };
          const closing = yieldPart(elements);
          if (!closing.more) carried = undefined;
          return closing;
        }
        elements.push(entry);
        partBytes += size;
      }
      return close(elements, false);
    },
    cancel() {
      assertOpen();
      const elements = carried ? [carried.entry] : [];
      context.truncated = true;
      return close(elements, false);
    },
    serialize,
  };
}
