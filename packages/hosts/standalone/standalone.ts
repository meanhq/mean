import { projectRelayPort } from '../../core/relay/project-state.js';
import { startModuleRelay } from '../../core/relay/server.js';

export class StandaloneError extends Error {}

export async function startStandalone(
  origins: readonly string[],
  options: { port?: number; rotateToken?: boolean; projectRoot?: string } = {},
): ReturnType<typeof startModuleRelay> {
  if (process.env.NODE_ENV === 'production') throw new StandaloneError('Mean is development only');
  const root = options.projectRoot ?? process.cwd();
  const port = options.port ?? projectRelayPort(root);
  let relay: Awaited<ReturnType<typeof startModuleRelay>>;
  try {
    relay = await startModuleRelay(origins, {
      projectRoot: root,
      ...(port === undefined ? {} : { port }),
      ...(options.rotateToken === undefined ? {} : { rotateToken: options.rotateToken }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new StandaloneError(
        `Mean port ${port} is in use; stop its server or use --port N to store a new port and print a new tag.`,
      );
    throw error;
  }
  try {
    const actual = Number(new URL(relay.origin).port);
    const saved = projectRelayPort(root, actual, options.port !== undefined);
    if (saved !== actual)
      throw new StandaloneError(
        `Mean port ${saved} was selected by another process; restart or use --port N to store a new port and print a new tag.`,
      );
    return relay;
  } catch (error) {
    await relay.close();
    throw error;
  }
}
