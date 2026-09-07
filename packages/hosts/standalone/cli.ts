#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StandaloneError, startStandalone } from './standalone.js';

try {
  const { values } = parseArgs({
    options: {
      origin: { type: 'string', multiple: true },
      port: { type: 'string' },
      'rotate-token': { type: 'boolean', default: false },
    },
  });
  const relay = await startStandalone(values.origin ?? [], {
    ...(values.port === undefined ? {} : { port: Number(values.port) }),
    rotateToken: values['rotate-token'],
  });
  console.log(relay.script);
  const close = (): void => {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    void relay.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  console.error(
    error instanceof StandaloneError
      ? error.message
      : 'Mean could not start; use a loopback --origin, a valid --port and private project relay state (development only).',
  );
  process.exitCode = 1;
}
