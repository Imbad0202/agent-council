import type { CliCommandHandler } from './cli-commands.js';

export interface RouterForCliDispatch {
  handleHumanMessage(msg: {
    id: string;
    role: 'human';
    content: string;
    timestamp: number;
    threadId: number;
  }): void;
}

// CLI input router used by src/index.ts in the adapter.start callback. Slash
// commands go to CliCommandHandler.handleAsync (which owns /councilreset and
// /councilhistory plus its 'not configured' fallbacks); everything else goes
// to the event-driven deliberation pipeline via GatewayRouter.
export async function routeCliInput(
  line: string,
  router: RouterForCliDispatch,
  cliCmd: Pick<CliCommandHandler, 'handleAsync'>,
  threadId: number,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    await cliCmd.handleAsync(command, args);
    return;
  }

  router.handleHumanMessage({
    id: `cli-${Date.now()}`,
    role: 'human',
    content: trimmed,
    timestamp: Date.now(),
    threadId,
  });
}
