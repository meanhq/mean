import { parse } from '@babel/parser';
import traverseImport from '@babel/traverse';
import MagicString, { type SourceMap } from 'magic-string';
import { projectSourceFile, STAMP_ATTRIBUTE } from '../html/template.js';

// @babel/traverse is CommonJS; some loaders hand its default export over wrapped once more.
const traverse: typeof traverseImport =
  typeof traverseImport === 'function'
    ? traverseImport
    : (traverseImport as unknown as { default: typeof traverseImport }).default;

export function stampJSX(
  code: string,
  id: string,
  root: string,
): { code: string; map: SourceMap } | undefined {
  const filename = id.split('?')[0] ?? '';
  if (!/\.(?:jsx?|tsx)$/.test(filename)) return;
  const file = projectSourceFile(filename, root);
  if (!file) return;
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', ...(filename.endsWith('.tsx') ? ['typescript' as const] : [])],
    });
  } catch {
    // Syntax this parser rejects may still be valid for the project's own framework plugin.
    return;
  }
  const edited = new MagicString(code);
  traverse(ast, {
    JSXOpeningElement(path) {
      const node = path.node;
      // Host elements only: lowercase names. Components are named by the React adapter at runtime.
      if (
        node.name.type !== 'JSXIdentifier' ||
        !/^[a-z]/.test(node.name.name) ||
        !node.loc ||
        node.end == null
      )
        return;
      for (const attribute of node.attributes) {
        if (
          attribute.type === 'JSXAttribute' &&
          attribute.name.type === 'JSXIdentifier' &&
          attribute.name.name === STAMP_ATTRIBUTE &&
          attribute.start != null &&
          attribute.end != null
        )
          edited.remove(attribute.start, attribute.end);
      }
      const stamp = JSON.stringify({
        file,
        line: node.loc.start.line,
        column: node.loc.start.column + 1,
      });
      // Appended after any spread so props cannot override the compiler's evidence.
      edited.appendLeft(
        node.end - (node.selfClosing ? 2 : 1),
        ` ${STAMP_ATTRIBUTE}={${JSON.stringify(stamp)}}`,
      );
    },
  });
  if (!edited.hasChanged()) return;
  return {
    code: edited.toString(),
    map: edited.generateMap({ source: filename, includeContent: true, hires: true }),
  };
}
