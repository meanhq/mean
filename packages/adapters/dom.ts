import type { Adapter } from './adapter.js';

// The fallback lane: every element qualifies and none gains a component or source.
export const dom: Adapter = { id: 'dom', detect: () => true, resolve: () => ({}) };
