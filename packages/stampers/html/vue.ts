import MagicString, { type SourceMap } from 'magic-string';
import { isRecord } from '../../protocol/validation.js';
import { createTemplateStamper, projectSourceFile, STAMP_ATTRIBUTE } from './template.js';

const ELEMENT = 1;
const HOST_ELEMENT = 0;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;
const SIMPLE_EXPRESSION = 4;

export async function stampVue(
  code: string,
  id: string,
  root: string,
): Promise<{ code: string; map: SourceMap } | undefined> {
  if (!id.endsWith('.vue')) return;
  const file = projectSourceFile(id, root);
  if (!file) return;
  let compiler: typeof import('vue/compiler-sfc');
  try {
    compiler = await import('vue/compiler-sfc');
  } catch (error) {
    if (
      !isRecord(error) ||
      (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND')
    )
      throw error;
    return;
  }
  const { descriptor, errors } = compiler.parse(code, { filename: id });
  const template = descriptor.template;
  if (
    errors.length ||
    !template?.ast ||
    template.src ||
    (template.lang && template.lang !== 'html')
  )
    return;
  const edited = new MagicString(code);
  const stamp = createTemplateStamper(edited, code, file, false);
  const children = template.ast.children;
  function visit(nodes: typeof children): void {
    for (const node of nodes) {
      if (node.type !== ELEMENT) continue;
      if (node.tagType === HOST_ELEMENT && !['script', 'style', 'template'].includes(node.tag)) {
        for (const attribute of node.props) {
          if (
            (attribute.type === ATTRIBUTE && attribute.name === STAMP_ATTRIBUTE) ||
            (attribute.type === DIRECTIVE &&
              attribute.name === 'bind' &&
              attribute.arg?.type === SIMPLE_EXPRESSION &&
              attribute.arg.isStatic &&
              attribute.arg.content === STAMP_ATTRIBUTE)
          )
            edited.remove(attribute.loc.start.offset, attribute.loc.end.offset);
        }
        const last = node.props.at(-1);
        const afterAttributes = last?.loc.end.offset ?? node.loc.start.offset + node.tag.length + 1;
        const close = code.indexOf('>', afterAttributes);
        if (close >= 0) stamp(node.loc.start.offset, code[close - 1] === '/' ? close - 1 : close);
      }
      visit(node.children);
    }
  }
  visit(children);
  return {
    code: edited.toString(),
    map: edited.generateMap({ source: id, includeContent: true, hires: true }),
  };
}
