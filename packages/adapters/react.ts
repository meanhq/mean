import { toProjectSource } from '../protocol/source.js';
import { isRecord } from '../protocol/validation.js';
import {
  type Adapter,
  appendName,
  type Identity,
  identityFromChain,
  MAX_OWNER_STEPS,
} from './adapter.js';
import { readSourceStamp } from './source.js';

const MAX_KEY_CANDIDATES = 64;

// Own keys only, so the DOM prototype chain is never enumerated; the cap bounds expando-heavy elements.
function fiberOf(element: Element): unknown {
  const keys = Object.keys(element);
  const limit = Math.min(keys.length, MAX_KEY_CANDIDATES);
  for (let index = 0; index < limit; index++) {
    const key = keys[index];
    if (key && (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')))
      return (element as unknown as Record<string, unknown>)[key];
  }
}

function displayName(value: unknown): unknown {
  return typeof value === 'function'
    ? (value as { displayName?: string }).displayName || value.name
    : undefined;
}

// Named composites, memo and forwardRef wrappers only; Context and other exotic types have no owner name.
function componentName(type: unknown): unknown {
  if (typeof type === 'function') return displayName(type);
  if (
    !isRecord(type) ||
    (type.$$typeof !== Symbol.for('react.memo') &&
      type.$$typeof !== Symbol.for('react.forward_ref'))
  )
    return undefined;
  if (type.displayName) return type.displayName;
  if (typeof type.type === 'function') return displayName(type.type);
  if (typeof type.render === 'function') return displayName(type.render);
}

export const react: Adapter = {
  id: 'react',
  detect: (element) => isRecord(fiberOf(element)),
  resolve(element, context) {
    let fiber = fiberOf(element);
    if (!isRecord(fiber)) return {};
    const identity: Identity = {};
    const source = readSourceStamp(element, context);
    if (source) identity.source = source;
    const chain: string[] = [];
    let steps = 0;
    while (isRecord(fiber) && steps++ < MAX_OWNER_STEPS) {
      if (performance.now() >= context.deadline) {
        context.truncated = true;
        break;
      }
      const component = componentName(fiber.type);
      if (component !== undefined) appendName(chain, component, context);
      if (!identity.source && isRecord(fiber._debugSource)) {
        const debug = fiber._debugSource;
        const location = toProjectSource(
          { file: debug.fileName, line: debug.lineNumber, column: debug.columnNumber },
          context.projectRoot,
        );
        if (location) identity.source = location;
        else context.truncated = true;
      }
      fiber = fiber.return;
    }
    if (isRecord(fiber)) context.truncated = true;
    return identityFromChain(identity, chain);
  },
};
