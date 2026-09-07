import MagicString, { type SourceMap } from 'magic-string';
import type { AST, PreprocessorGroup } from 'svelte/compiler';
import { isRecord } from '../../protocol/validation.js';
import { createTemplateStamper, projectSourceFile, STAMP_ATTRIBUTE } from './template.js';

export async function stampSvelte(
  code: string,
  id: string,
  root: string,
): Promise<{ code: string; map: SourceMap } | undefined> {
  if (!id.endsWith('.svelte')) return;
  const file = projectSourceFile(id, root);
  if (!file) return;
  let compiler: typeof import('svelte/compiler');
  try {
    compiler = await import('svelte/compiler');
  } catch (error) {
    if (
      !isRecord(error) ||
      (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND')
    )
      throw error;
    return;
  }
  let ast: AST.Root;
  try {
    // Let Svelte find style blocks, then mask only their content without moving any source offset.
    const masked = await compiler.preprocess(
      code,
      {
        style: ({ content }) => ({ code: content.replace(/[^\r\n]/g, ' ') }),
      },
      { filename: id },
    );
    if (masked.code.length !== code.length) return;
    ast = compiler.parse(masked.code, { modern: true });
  } catch {
    // Leave syntax owned by another preprocessor to that preprocessor.
    return;
  }
  const edited = new MagicString(code);
  const stamp = createTemplateStamper(edited, code, file, true);
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (
      value.type === 'RegularElement' &&
      typeof value.name === 'string' &&
      !['script', 'style', 'template'].includes(value.name) &&
      typeof value.start === 'number' &&
      Array.isArray(value.attributes)
    ) {
      let afterAttributes = value.start + value.name.length + 1;
      for (const attribute of value.attributes) {
        if (!isRecord(attribute) || typeof attribute.end !== 'number') continue;
        afterAttributes = attribute.end;
        if (attribute.name === STAMP_ATTRIBUTE && typeof attribute.start === 'number')
          edited.remove(attribute.start, attribute.end);
      }
      const close = code.indexOf('>', afterAttributes);
      if (close >= 0) stamp(value.start, code[close - 1] === '/' ? close - 1 : close);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['attributes', 'expression', 'instance', 'module', 'css'].includes(key)) visit(child);
    }
  }
  visit(ast);
  return {
    code: edited.toString(),
    map: edited.generateMap({ source: id, includeContent: true, hires: true }),
  };
}

export function meanSveltePreprocess(root: string, dev: boolean): PreprocessorGroup {
  return {
    name: 'mean-source',
    ...(dev
      ? {
          markup: ({ content, filename }) =>
            filename ? stampSvelte(content, filename, root) : undefined,
        }
      : {}),
  };
}
