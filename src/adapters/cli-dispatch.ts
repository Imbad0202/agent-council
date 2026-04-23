import { CLI_COMMAND_NAMES, type CliCommandHandler } from './cli-commands.js';

export interface RouterForCliDispatch {
  handleHumanMessage(msg: {
    id: string;
    role: 'human';
    content: string;
    timestamp: number;
    threadId: number;
  }): void;
}

// CLI input router used by src/index.ts in the adapter.start callback. Lines
// whose first token (after `/`) matches CLI_COMMAND_NAMES go to
// CliCommandHandler.handleAsync; everything else — including absolute paths
// (`/Users/...`), shell snippets (`/bin/bash -lc ...`), and unknown slash
// strings — goes to the event-driven deliberation pipeline via GatewayRouter.
//
// Round-11 codex finding [P2]: a permissive `startsWith('/')` rule turned
// every path/shell prompt into "Unknown command", so the dispatcher now
// pulls the whitelist from cli-commands.ts (single source of truth).
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
    if (CLI_COMMAND_NAMES.has(command)) {
      await cliCmd.handleAsync(command, args);
      return;
    }
    // Unknown slash — fall through to deliberation. A typo like
    // `/councilrest` becomes a plain user message; the user sees no agent
    // response that matches a command, which is a clearer failure mode
    // than the old "Unknown command" string mid-CLI-prompt.
  }

  router.handleHumanMessage({
    id: `cli-${Date.now()}`,
    role: 'human',
    content: trimmed,
    timestamp: Date.now(),
    threadId,
  });
}
