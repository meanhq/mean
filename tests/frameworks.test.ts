// @vitest-environment jsdom
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compile, preprocess } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { compileTemplate, parse as parseVue } from 'vue/compiler-sfc';
import type { Context } from '../packages/adapters/adapter.js';
import { react } from '../packages/adapters/react.js';
import { readSourceStamp } from '../packages/adapters/source.js';
import { svelte } from '../packages/adapters/svelte.js';
import { vue } from '../packages/adapters/vue.js';
import { meanSveltePreprocess, stampSvelte } from '../packages/stampers/html/svelte.js';
import { stampVue } from '../packages/stampers/html/vue.js';

const context = (): Context => ({ projectRoot: '/project', deadline: Infinity, truncated: false });
const location = { file: 'src/Panel.vue', line: 8, column: 3 };

function stamped(): HTMLElement {
  const element = document.createElement('button');
  element.setAttribute('data-mean-source', JSON.stringify(location));
  return element;
}

describe('Framework adapters', () => {
  it('does not classify a plain stamp as a framework or steal another framework stamp', () => {
    const element = stamped();
    for (const adapter of [react, vue, svelte]) {
      expect(adapter.detect(element)).toBe(false);
      expect(adapter.resolve(element, context())).toEqual({});
    }
    expect(readSourceStamp(element, context())).toEqual(location);
    Object.assign(element, { __vueParentComponent: { type: { name: 'Panel' } } });
    expect(react.resolve(element, context())).toEqual({});
    expect(vue.resolve(element, context())).toEqual({
      source: location,
      component: 'Panel',
      chain: ['Panel'],
    });
  });

  it('uses Vue metadata names nearest first and never invents a line from its file', () => {
    const element = document.createElement('div');
    Object.assign(element, {
      __vueParentComponent: {
        type: { name: 'Panel', __file: '/project/src/Panel.vue' },
        parent: { type: { __name: 'Panel' }, parent: { type: { name: 'App' } } },
      },
    });
    expect(vue.resolve(element, context())).toEqual({
      component: 'Panel',
      chain: ['Panel', 'Panel', 'App'],
    });
    Object.assign(element, {
      __vueParentComponent: { type: { __file: '/project/src/Panel.vue' } },
    });
    expect(vue.resolve(element, context())).toEqual({});
    element.setAttribute('data-mean-source', JSON.stringify(location));
    expect(vue.resolve(element, context())).toEqual({ source: location });
  });

  it('supports legacy Vue owner links without reading props or inherited metadata', () => {
    const element = document.createElement('div');
    Object.assign(element, {
      __vue__: {
        $options: { name: 'Legacy' },
        $parent: { $options: { name: 'Root' } },
        get type() {
          throw new Error('Vue 2 application prop must not be read');
        },
        get parent() {
          throw new Error('Vue 2 application prop must not be read');
        },
      },
    });
    expect(vue.resolve(element, context()).chain).toEqual(['Legacy', 'Root']);
    const inherited = Object.create(element) as Element;
    expect(vue.detect(inherited)).toBe(false);
    expect(svelte.detect(inherited)).toBe(false);
  });

  it('bounds Vue parent cycles, names, chain length and elapsed time', () => {
    const owner: Record<string, unknown> = { type: { name: 'Panel' } };
    owner.parent = owner;
    const element = Object.assign(stamped(), { __vueParentComponent: owner });
    const state = context();
    expect(vue.resolve(element, state).chain).toHaveLength(12);
    expect(state.truncated).toBe(true);
    owner.type = { name: 'x'.repeat(129) };
    expect(vue.resolve(element, context()).component).toBeUndefined();
    const expired = { ...context(), deadline: -1 };
    expect(vue.resolve(element, expired)).toEqual({ source: location });
    expect(expired.truncated).toBe(true);
  });

  it('uses Svelte native locations with 1-based lines and zero-based columns but no guessed names', () => {
    const element = Object.assign(document.createElement('button'), {
      __svelte_meta: {
        loc: { file: '/project/src/Panel.svelte', line: 3, column: 2 },
        parent: { file: '/project/src/App.svelte' },
      },
    });
    expect(svelte.resolve(element, context())).toEqual({
      source: { file: 'src/Panel.svelte', line: 3, column: 3 },
    });
    element.setAttribute('data-mean-source', JSON.stringify(location));
    expect(svelte.resolve(element, context())).toEqual({ source: location });
    element.removeAttribute('data-mean-source');
    element.__svelte_meta.loc.file = '/private/Panel.svelte';
    expect(svelte.resolve(element, context())).toEqual({});
    element.__svelte_meta.loc.file = 'src/Panel.svelte';
    element.__svelte_meta.loc.column = -1;
    expect(svelte.resolve(element, context())).toEqual({});
    const legacy = Object.assign(document.createElement('div'), {
      __svelte_meta: { loc: { file: 'src/Panel.svelte', line: 3, column: 2 } },
    });
    expect(svelte.resolve(legacy, context())).toEqual({});
  });

  it('rejects malformed, oversized and unsafe source stamps without reading private attributes', () => {
    const element = stamped();
    for (const stamp of [
      '{',
      JSON.stringify({ file: '../secret', line: 1 }),
      JSON.stringify({ file: 'file:///secret', line: 1 }),
      JSON.stringify({ file: 'src/file', line: 0 }),
      'x'.repeat(4097),
    ]) {
      element.setAttribute('data-mean-source', stamp);
      expect(readSourceStamp(element, context())).toBeUndefined();
    }
  });
});

describe('Framework adapters: Svelte recorded owners', () => {
  it('uses named component entries but not filenames, control blocks or dynamic tags', () => {
    const element = Object.assign(stamped(), {
      __svelte_meta: {
        parent: {
          type: 'if',
          parent: {
            type: 'component',
            componentTag: 'Child',
            parent: {
              type: 'component',
              componentTag: 'svelte:component',
              parent: {
                type: 'component',
                componentTag: 'Panel',
                parent: null,
              },
            },
          },
        },
      },
    });
    expect(svelte.resolve(element, context())).toEqual({
      source: location,
      component: 'Child',
      chain: ['Child', 'Panel'],
    });
    element.removeAttribute('data-mean-source');
    expect(svelte.resolve(element, context())).toEqual({
      component: 'Child',
      chain: ['Child', 'Panel'],
    });
    const owner: Record<string, unknown> = { type: 'component', componentTag: 'Child' };
    owner.parent = owner;
    const cycle = Object.assign(stamped(), { __svelte_meta: { parent: owner } });
    const state = context();
    expect(svelte.resolve(cycle, state).chain).toHaveLength(12);
    expect(state.truncated).toBe(true);
    const expired = { ...context(), deadline: -1 };
    expect(svelte.resolve(cycle, expired)).toEqual({ source: location });
    expect(expired.truncated).toBe(true);
  });
});

describe('Source stamps', () => {
  it('pins the Svelte compiler location units independently of Mean stamps', () => {
    const output = compile('\n<main>\n  <button>Save</button>\n</main>', {
      filename: '/project/src/Panel.svelte',
      dev: true,
      generate: 'client',
    });
    expect(output.js.code).toContain('[[2, 0, [[3, 2]]]]');
  });

  it('stamps Vue host tags at original SFC offsets and leaves components and scripts alone', async () => {
    const code =
      '<script setup>const value = ">"</script>\r\n<template>\r\n  <main><Panel/><button :title="value" data-mean-source="forged">Save</button></main>\r\n</template>';
    const result = await stampVue(code, '/project/src/Panel.vue', '/project');
    expect(result).toBeDefined();
    const template = parseVue(result?.code ?? '').descriptor.template;
    expect(template).toBeTruthy();
    const compiled = compileTemplate({
      source: template?.content ?? '',
      filename: 'src/Panel.vue',
      id: 'panel',
    });
    expect(compiled.errors).toEqual([]);
    expect(result?.code).toContain('<Panel/>');
    expect(result?.code).not.toContain('forged');
    expect(result?.code).toContain('&quot;line&quot;:3,&quot;column&quot;:3');
    expect(result?.code).toContain('&quot;line&quot;:3,&quot;column&quot;:17');
    expect(result?.map.sourcesContent).toEqual([code]);
  });

  it('stamps nested Svelte blocks and spreads with exact original positions', async () => {
    const code =
      '<script>let ok=true;let props={};</script>\n{#if ok}\n  <button {...props} data-mean-source="forged" title=">">Save</button>\n{:else}<span />{/if}';
    const result = await stampSvelte(code, '/project/src/Panel.svelte', '/project');
    expect(result?.code).not.toContain('forged');
    expect(result?.code).toContain('\\"line\\":3,\\"column\\":3');
    expect(result?.code).toContain('\\"line\\":4,\\"column\\":8');
    expect(() =>
      compile(result?.code ?? '', { filename: '/project/src/Panel.svelte', dev: true }),
    ).not.toThrow();
    expect(result?.map.sourcesContent).toEqual([code]);
  });

  it('preserves Svelte offsets around preprocessed styles without altering style content', async () => {
    const code =
      '<style lang="scss">\n$c: red; button { color: $c; }\n</style>\n  <button title={1 > 0}>Save</button>';
    const result = await stampSvelte(code, '/project/src/Panel.svelte', '/project');
    expect(result?.code).toContain('$c: red; button { color: $c; }');
    expect(result?.code).toContain('\\"line\\":4,\\"column\\":3');
    expect(result?.map.sourcesContent).toEqual([code]);
  });

  it('omits stamps when optional compilers are not installed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mean-optional-compilers-'));
    const exec = promisify(execFile);
    try {
      await exec('corepack', [
        'pnpm',
        'exec',
        'esbuild',
        'packages/stampers/html/vue.ts',
        'packages/stampers/html/svelte.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--external:vue/compiler-sfc',
        '--external:svelte/compiler',
        `--outdir=${directory}`,
        '--out-extension:.js=.mjs',
      ]);
      await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import assert from 'node:assert/strict';
        import { stampVue } from './vue.mjs';
        import { stampSvelte } from './svelte.mjs';
        assert.equal(await stampVue('<template><button/></template>', '/project/Panel.vue', '/project'), undefined);
        assert.equal(await stampSvelte('<button/>', '/project/Panel.svelte', '/project'), undefined);
      `,
        ],
        { cwd: directory },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('provides a Svelte markup preprocessor that does nothing in production', async () => {
    const code = '<button>Save</button>';
    const options = { filename: '/project/src/Panel.svelte' };
    const development = await preprocess(code, meanSveltePreprocess('/project', true), options);
    expect(development.code).toContain('data-mean-source');
    const production = await preprocess(code, meanSveltePreprocess('/project', false), options);
    expect(production.code).toBe(code);
  });

  it('leaves external paths, query modules, unsupported templates and malformed syntax unstamped', async () => {
    for (const [stamp, extension, code] of [
      [stampVue, '.vue', '<template><button/></template>'],
      [stampSvelte, '.svelte', '<button/>'],
    ] as const) {
      for (const id of [
        `/other/Panel${extension}`,
        `/project/node_modules/Panel${extension}`,
        `/project/Panel${extension}?raw`,
      ])
        expect(await stamp(code, id, '/project')).toBeUndefined();
    }
    expect(
      await stampVue(
        '<template lang="pug">button Save</template>',
        '/project/Panel.vue',
        '/project',
      ),
    ).toBeUndefined();
    expect(
      await stampVue('<template src="./other.html"/>', '/project/Panel.vue', '/project'),
    ).toBeUndefined();
    expect(
      await stampVue('<template><button></template>', '/project/Panel.vue', '/project'),
    ).toBeUndefined();
    expect(await stampSvelte('{#if}', '/project/Panel.svelte', '/project')).toBeUndefined();
  });
});
