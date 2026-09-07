import { isRecord } from '../protocol/validation.js';
import {
  type Adapter,
  appendName,
  type Identity,
  identityFromChain,
  MAX_OWNER_STEPS,
} from './adapter.js';
import { readSourceStamp } from './source.js';

function instanceOf(element: Element): unknown {
  const metadata = element as unknown as Record<string, unknown>;
  if (Object.hasOwn(element, '__vueParentComponent')) return metadata.__vueParentComponent;
  if (Object.hasOwn(element, '__vue__')) return metadata.__vue__;
}

export const vue: Adapter = {
  id: 'vue',
  detect: (element) => isRecord(instanceOf(element)),
  resolve(element, context) {
    let instance = instanceOf(element);
    if (!isRecord(instance)) return {};
    const legacy = !Object.hasOwn(element, '__vueParentComponent');
    const identity: Identity = {};
    const source = readSourceStamp(element, context);
    if (source) identity.source = source;
    const chain: string[] = [];
    let steps = 0;
    while (isRecord(instance) && steps++ < MAX_OWNER_STEPS) {
      if (performance.now() >= context.deadline) {
        context.truncated = true;
        break;
      }
      const options = legacy ? instance.$options : instance.type;
      if (isRecord(options)) {
        const name = options.name || options.__name;
        if (name !== undefined) appendName(chain, name, context);
      }
      // A file alone is not a render location. Vue's ordinary __file is deliberately unused.
      instance = legacy ? instance.$parent : instance.parent;
    }
    if (isRecord(instance)) context.truncated = true;
    return identityFromChain(identity, chain);
  },
};
