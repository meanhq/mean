import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

const schema = JSON.parse(
  await readFile(new URL('../packages/protocol/schema/dom.v1.json', import.meta.url), 'utf8'),
);
const types = await compile(schema, 'PageMessage', {
  bannerComment: '/* Generated from schema/dom.v1.json. Do not edit. */',
  additionalProperties: true,
});
await writeFile(new URL('../packages/protocol/src/index.ts', import.meta.url), types);
