import { CLI_COMMAND_NAMES, type CliCommandHandler } from './cli-commands.js';

// Round-14 codex finding [P2-W]: CLI used to hard-code threadId: 0 in two
// places (CliCommandHandler reset wiring + adapter callback). Combined with
// round-9's restart-safe getSnapshotPrefix DB fallback, that meant a new
// CLI session would inherit the previous run's /councilreset summary as
// shared context, and /councilhistory merged unrelated CLI sessions
// together — a real cross-session leak, not just stale UX.
//
// Each CLI invocation now gets its own threadId, derived from the process
// startup epoch. Caller passes a `now` function for deterministic tests;
// production callers in src/index.ts use `Date.now`. Telegram threadIds
// stay normalized to 0 because their session boundary is the chat / reply
// thread, not the OS process.
//
// Side effect: existing CLI users lose direct visibility into snapshots
// recorded under the legacy thread 0 — those rows are still in
// data/council.db but the new threadId won't match them. CHANGELOG flags
// this as a deliberate privacy trade-off.
export function deriveCliThreadId(now: () => number = Date.now): number {
  return now();
}

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
