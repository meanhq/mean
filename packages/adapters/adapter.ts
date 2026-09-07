import type { Source } from '../protocol/source.js';
import { isBoundedString } from '../protocol/validation.js';

export interface Identity {
  component?: string;
  chain?: string[];
  source?: Source;
}

// One per probe or walk request. Adapters set truncated when a limit dropped evidence.
export interface Context {
  projectRoot: string;
  deadline: number;
  truncated: boolean;
}

export interface Adapter {
  id: string;
  detect(element: Element): boolean;
  resolve(element: Element, context: Context): Identity;
}

export const MAX_OWNER_STEPS = 128;
export const MAX_CHAIN = 12;
export const MAX_NAME = 128;

// Names are complete or absent; an oversized or thirteenth name marks the result truncated.
export function appendName(chain: string[], name: unknown, context: Context): void {
  if (isBoundedString(name, MAX_NAME) && chain.length < MAX_CHAIN) chain.push(name);
  else context.truncated = true;
}

export function identityFromChain(identity: Identity, chain: string[]): Identity {
  if (chain[0]) {
    identity.component = chain[0];
    identity.chain = chain;
  }
  return identity;
}
