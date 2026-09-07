// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { stampHTML } from '../packages/stampers/html/html.js';

function stamped(code: string): Document {
  const result = stampHTML(code, '/project/index.html', '/project');
  if (!result) throw new Error('HTML was not stamped');
  return new DOMParser().parseFromString(result.code, 'text/html');
}

function source(element: Element | null): unknown {
  return JSON.parse(element?.getAttribute('data-mean-source') ?? 'null');
}

describe('Source stamps', () => {
  it('records original tag positions without inventing locations for implied elements', () => {
    const document = stamped('<!doctype html>\n<main>\n  <button>Save</button>\n</main>');
    expect(source(document.querySelector('button'))).toEqual({
      file: 'index.html',
      line: 3,
      column: 3,
    });
    expect(source(document.documentElement)).toBeNull();
    expect(source(document.body)).toBeNull();
  });

  it('parses comments, raw text, quoted brackets, template contents and foreign elements as HTML', () => {
    const document = stamped(`<!-- <button>not a tag</button> -->
<script>const fake = '<button>not a tag</button>';</script>
<style>.test { content: '<button>'; }</style>
<textarea><button>private text</button></textarea>
<template><button>Template button</button></template>
<svg><path d="M 0 0" /></svg>
<button title=">">Save</button>`);
    expect(source(document.querySelector('button'))).toEqual({
      file: 'index.html',
      line: 7,
      column: 1,
    });
    expect(document.querySelector('script')?.textContent).toBe(
      "const fake = '<button>not a tag</button>';",
    );
    expect(source(document.querySelector('script'))).toBeNull();
    expect(source(document.querySelector('path'))).toEqual({
      file: 'index.html',
      line: 6,
      column: 6,
    });
    expect(
      source(document.querySelector('template')?.content.querySelector('button') ?? null),
    ).toEqual({ file: 'index.html', line: 5, column: 11 });
  });

  it('replaces pre-existing reserved attributes with compiler evidence and escapes source filenames', () => {
    const result = stampHTML(
      '<button data-mean-source="invented"/>',
      '/project/a&"b.html',
      '/project',
    );
    if (!result) throw new Error('HTML was not stamped');
    expect(
      source(new DOMParser().parseFromString(result.code, 'text/html').querySelector('button')),
    ).toEqual({ file: 'a&"b.html', line: 1, column: 1 });
    expect(result.map.sources).toEqual(['/project/a&"b.html']);
  });

  it('does not stamp dependencies, files outside the project or non-HTML inputs', () => {
    for (const path of [
      '/elsewhere/index.html',
      '/project/node_modules/index.html',
      '/project/App.vue',
    ]) {
      expect(stampHTML('<button/>', path, '/project')).toBeUndefined();
    }
  });
});
