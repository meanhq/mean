import { fileURLToPath } from 'node:url';
import { mean } from '@meanhq/mean/middleware';
import { startFixture } from '../middleware-server.mjs';

await startFixture(fileURLToPath(new URL('.', import.meta.url)), 'koa', mean);
