import { copyFile, mkdir } from 'node:fs/promises';

const out = 'packages/mean/dist';
await mkdir(`${out}/schema`, { recursive: true });
await copyFile('packages/protocol/schema/dom.v1.json', `${out}/schema/dom.v1.json`);
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
  await copyFile(file, `packages/mean/${file}`);
}
