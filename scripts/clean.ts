import { rm } from 'node:fs/promises';

await rm(new URL('../packages/mean/dist', import.meta.url), { recursive: true, force: true });
