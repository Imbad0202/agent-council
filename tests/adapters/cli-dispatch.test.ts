import { describe, it, expect, vi } from 'vitest';
import { routeCliInput, deriveCliThreadId } from '../../src/adapters/cli-dispatch.js';
import { CLI_COMMAND_NAMES } from '../../src/adapters/cli-commands.js';

// Round-14 codex finding [P2-W]: CLI used to hard-code threadId: 0. Combined
// with round-9's restart-safe getSnapshotPrefix DB fallback, that meant a
// brand-new CLI session inherited the previous run's /councilreset summary
// as shared context, and /councilhistory merged unrelated CLI sessions
// together. deriveCliThreadId returns a per-process unique value so each
// CLI invocation is its own session boundary in the snapshot DB.
describe('deriveCliThreadId', () => {
  it('is non-zero so it does not collide with the legacy hard-coded thread 0', () => {
    expect(deriveCliThreadId(() => 1_700_000_000_000)).not.toBe(0);
  });

  it('returns the injected epoch so callers can derive a deterministic ID', () => {
    expect(deriveCliThreadId(() => 1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('produces distinct IDs for two CLI processes started at different epochs', () => {
    const a = deriveCliThreadId(() => 1_700_000_000_000);
    const b = deriveCliThreadId(() => 1_700_000_000_001);
    expect(a).not.toBe(b);
  });
});

describe('routeCliInput', () => {
  it('routes /councilreset to CliCommandHandler.handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/councilreset', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).toHaveBeenCalledWith('councilreset', '');
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });

  it('routes /councilhistory to CliCommandHandler.handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/councilhistory', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).toHaveBeenCalledWith('councilhistory', '');
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });

  it('passes args after the command name', async () => {
    const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/councilreset now please', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).toHaveBeenCalledWith('councilreset', 'now please');
  });

  it('routes non-command input to router.handleHumanMessage', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('just a regular message', router as never, cliCmd as never, 7);

    expect(router.handleHumanMessage).toHaveBeenCalledTimes(1);
    const msg = router.handleHumanMessage.mock.calls[0][0];
    expect(msg.content).toBe('just a regular message');
    expect(msg.role).toBe('human');
    expect(msg.threadId).toBe(7);
    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
  });

  // Round-11 codex finding [P2]: T11 originally kept dispatch dumb (any
  // leading `/` → handleAsync). In a coding-focused council, that turns
  // every absolute path (`/Users/...`) and shell snippet (`/bin/bash -lc ...`)
  // into "Unknown command" instead of letting it reach the deliberation
  // pipeline. Whitelist only the actual command names exported from
  // CliCommandHandler; everything else falls through.
  it('routes unknown /somecommand to deliberation, not handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/somecommand', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
    expect(router.handleHumanMessage).toHaveBeenCalledTimes(1);
    expect(router.handleHumanMessage.mock.calls[0][0].content).toBe('/somecommand');
  });

  it('routes absolute path /Users/foo/bar to deliberation, not handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/Users/imbad/Projects/foo.ts', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
    expect(router.handleHumanMessage).toHaveBeenCalledTimes(1);
    expect(router.handleHumanMessage.mock.calls[0][0].content).toBe(
      '/Users/imbad/Projects/foo.ts',
    );
  });

  it('routes shell-like /bin/bash -lc "echo hi" to deliberation, not handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/bin/bash -lc "echo hi"', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
    expect(router.handleHumanMessage).toHaveBeenCalledTimes(1);
    expect(router.handleHumanMessage.mock.calls[0][0].content).toBe(
      '/bin/bash -lc "echo hi"',
    );
  });

  it('still routes /help (a known sync command) to handleAsync', async () => {
    const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/help', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).toHaveBeenCalledWith('help', '');
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });

  // Round-12 codex finding [P2]: /quit /debug /resume are advertised in the
  // CLI banner and /help output but were not in CLI_COMMAND_NAMES, so
  // round-11's whitelist regression turned them into deliberation prompts.
  // They must stay on the CLI path. (Their actual handler implementations
  // are a separate gap — out of round-12 scope; for now they hit handle()'s
  // 'Unknown command' fallback, restoring pre-round-11 behaviour.)
  it.each(['quit', 'debug', 'resume'])(
    'routes advertised /%s to handleAsync, not deliberation',
    async (cmd) => {
      const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
      const router = { handleHumanMessage: vi.fn() };

      await routeCliInput(`/${cmd}`, router as never, cliCmd as never, 0);

      expect(cliCmd.handleAsync).toHaveBeenCalledWith(cmd, '');
      expect(router.handleHumanMessage).not.toHaveBeenCalled();
    },
  );

  it('empty line is a no-op (consistent with existing CLI adapter behaviour)', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('   ', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });
});

describe('/councilcancel CLI dispatch (v0.5.4 §7.6a)', () => {
  it('CLI_COMMAND_NAMES contains councilcancel', () => {
    expect(CLI_COMMAND_NAMES.has('councilcancel')).toBe(true);
  });

  it("routeCliInput('/councilcancel') dispatches via handleAsync, not router", async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };
    await routeCliInput('/councilcancel', router as never, cliCmd as never, 7);
    expect(cliCmd.handleAsync).toHaveBeenCalledWith('councilcancel', '');
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });
});
