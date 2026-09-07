import MagicString, { type SourceMap } from 'magic-string';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { escapeAttribute, projectSourceFile, STAMP_ATTRIBUTE } from './template.js';

export function stampHTML(
  code: string,
  id: string,
  root: string,
): { code: string; map: SourceMap } | undefined {
  const filename = id.split('?')[0] ?? '';
  if (!/\.html?$/.test(filename)) return;
  const file = projectSourceFile(filename, root);
  if (!file) return;
  const document = parse(code, { sourceCodeLocationInfo: true });
  const edited = new MagicString(code);
  const pending: DefaultTreeAdapterMap['node'][] = [document];
  const stamped = new Set<number>();
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ('childNodes' in node) for (const child of node.childNodes) pending.push(child);
    if ('content' in node) pending.push(node.content);
    if (!('tagName' in node) || ['script', 'style', 'template'].includes(node.tagName)) continue;
    const location = node.sourceCodeLocation;
    const tag = location?.startTag;
    // Implied elements have no source tag; parser-reconstructed formatting nodes may share one.
    if (!tag || stamped.has(tag.startOffset)) continue;
    stamped.add(tag.startOffset);
    const oldStamp = location?.attrs?.[STAMP_ATTRIBUTE];
    if (oldStamp) edited.remove(oldStamp.startOffset, oldStamp.endOffset);
    const stamp = escapeAttribute(
      JSON.stringify({ file, line: tag.startLine, column: tag.startCol }),
    );
    const nameEnd = code.slice(tag.startOffset).match(/^<[^\s/>]+/)?.[0].length;
    if (!nameEnd) continue;
    edited.appendLeft(tag.startOffset + nameEnd, ` ${STAMP_ATTRIBUTE}="${stamp}"`);
  }
  return {
    code: edited.toString(),
    map: edited.generateMap({ source: filename, includeContent: true, hires: true }),
  };
}
