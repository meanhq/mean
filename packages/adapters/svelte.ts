import { toProjectSource } from '../protocol/source.js';
import { isBoundedString, isRecord } from '../protocol/validation.js';
import {
  type Adapter,
  appendName,
  type Identity,
  identityFromChain,
  MAX_NAME,
  MAX_OWNER_STEPS,
} from './adapter.js';
import { readSourceStamp } from './source.js';

function metadataOf(element: Element): unknown {
  if (Object.hasOwn(element, '__svelte_meta'))
    return (element as unknown as Record<string, unknown>).__svelte_meta;
}

export const svelte: Adapter = {
  id: 'svelte',
  detect: (element) => isRecord(metadataOf(element)),
  resolve(element, context) {
    const metadata = metadataOf(element);
    if (!isRecord(metadata)) return {};
    const identity: Identity = {};
    const stamp = readSourceStamp(element, context);
    if (stamp) identity.source = stamp;
    else if (Object.hasOwn(metadata, 'parent') && isRecord(metadata.loc)) {
      if (performance.now() >= context.deadline) {
        context.truncated = true;
        return identity;
      }
      // Svelte 5.55.1 records parent even when null and uses 1-based lines, zero-based columns.
      // Loc-only records are not the tested shape and may use different line units.
      const { file, line, column } = metadata.loc;
      const source = toProjectSource(
        { file, line, column: typeof column === 'number' ? column + 1 : column },
        context.projectRoot,
      );
      if (source) identity.source = source;
      else context.truncated = true;
    }
    const chain: string[] = [];
    let owner: unknown = Object.hasOwn(metadata, 'parent') ? metadata.parent : undefined;
    let steps = 0;
    while (isRecord(owner) && steps++ < MAX_OWNER_STEPS) {
      if (performance.now() >= context.deadline) {
        context.truncated = true;
        break;
      }
      if (owner.type === 'component' && owner.componentTag !== undefined) {
        const name = owner.componentTag;
        // Dynamic legacy tags do not record the selected component's name.
        if (!isBoundedString(name, MAX_NAME)) context.truncated = true;
        else if (!name.startsWith('svelte:')) appendName(chain, name, context);
      }
      owner = owner.parent;
    }
    if (isRecord(owner)) context.truncated = true;
    return identityFromChain(identity, chain);
  },
};
