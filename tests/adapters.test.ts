// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../packages/adapters/adapter.js';
import { detectAdapters } from '../packages/adapters/detect.js';
import { react } from '../packages/adapters/react.js';
import { toProjectSource } from '../packages/protocol/source.js';

const context = (): Context => ({ projectRoot: '/project', deadline: Infinity, truncated: false });
describe('Framework adapters', () => {
  it('reads at most 64 own keys and ignores inherited fibre metadata', () => {
    const element = document.createElement('div');
    const prototype: Record<string, unknown> = Object.create(Object.getPrototypeOf(element));
    prototype.__reactFiber$inherited = { type: { displayName: 'NotAnOwner' } };
    Object.setPrototypeOf(element, prototype);
    expect(react.detect(element)).toBe(false);
    const late = element as unknown as Record<string, unknown>;
    for (let index = 0; index < 64; index++) late[`expando${index}`] = true;
    late.__reactFiber$late = { type: { displayName: 'TooLate' } };
    expect(react.detect(element)).toBe(false);
    const early = document.createElement('div') as unknown as Record<string, unknown>;
    for (let index = 0; index < 63; index++) early[`expando${index}`] = true;
    early.__reactFiber$early = { type: { displayName: 'Owner' } };
    expect(react.detect(early as unknown as Element)).toBe(true);
  });
  it('prefers the exact stamp over fibre source and keeps repeated names nearest first', () => {
    const element = document.createElement('button');
    element.setAttribute(
      'data-mean-source',
      JSON.stringify({ file: 'src/Button.tsx', line: 7, column: 3 }),
    );
    Object.assign(element, {
      __reactFiber$test: {
        type: 'button',
        _debugSource: { fileName: '/project/wrong.tsx', lineNumber: 2 },
        return: {
          type: Object.assign(() => null, { displayName: 'Button' }),
          return: { type: Object.assign(() => null, { displayName: 'Button' }) },
        },
      },
    });
    expect(react.resolve(element, context())).toEqual({
      source: { file: 'src/Button.tsx', line: 7, column: 3 },
      component: 'Button',
      chain: ['Button', 'Button'],
    });
  });
  it('names memo and forwardRef wrappers but not Context objects', () => {
    const element = document.createElement('div');
    Object.assign(element, {
      __reactFiber$test: {
        type: { $$typeof: Symbol.for('react.context'), displayName: 'PrivateContext' },
        return: {
          type: { $$typeof: Symbol.for('react.memo'), displayName: 'Memo' },
          return: {
            type: { $$typeof: Symbol.for('react.forward_ref'), render: function Forward() {} },
          },
        },
      },
    });
    expect(react.resolve(element, context())).toEqual({
      component: 'Memo',
      chain: ['Memo', 'Forward'],
    });
  });
  it('never reads metadata on editable or form control descendants during detection', () => {
    document.body.innerHTML =
      '<div contenteditable><span></span></div><select><option></option></select><textarea>private</textarea>';
    const privateNodes = [...document.querySelectorAll('span, option')];
    const getter = vi.fn(() => {
      throw new Error('Private metadata was accessed');
    });
    for (const element of privateNodes)
      Object.defineProperty(element, '__reactFiber$private', { enumerable: true, get: getter });
    try {
      expect(detectAdapters(context())).toEqual([]);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      document.body.innerHTML = '';
    }
  });
  it('reports source without a name and rejects paths outside the project', () => {
    const element = document.createElement('div');
    Object.assign(element, {
      __reactFiber$x: {
        type: 'div',
        _debugSource: { fileName: '/project/src/render.tsx', lineNumber: 9 },
      },
    });
    expect(react.resolve(element, context())).toEqual({
      source: { file: 'src/render.tsx', line: 9 },
    });
    expect(toProjectSource({ file: '/other/private.ts', line: 1 }, '/project')).toBeUndefined();
    expect(toProjectSource({ file: 'src/../private.ts', line: 1 }, '/project')).toBeUndefined();
    expect(
      toProjectSource({ file: 'https://example.com/file.ts', line: 1 }, '/project'),
    ).toBeUndefined();
  });
  it('gives up on fibre cycles and oversized names and marks the result truncated', () => {
    const element = document.createElement('div');
    const fiber: Record<string, unknown> = {
      type: Object.assign(() => null, { displayName: 'x'.repeat(129) }),
    };
    fiber.return = fiber;
    Object.assign(element, { __reactFiber$x: fiber });
    const state = context();
    expect(react.resolve(element, state)).toEqual({});
    expect(state.truncated).toBe(true);
  });
});
