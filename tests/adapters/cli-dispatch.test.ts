import { describe, it, expect, vi } from 'vitest';
import { routeCliInput } from '../../src/adapters/cli-dispatch.js';

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

  it('empty line is a no-op (consistent with existing CLI adapter behaviour)', async () => {
    const cliCmd = { handleAsync: vi.fn() };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('   ', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).not.toHaveBeenCalled();
    expect(router.handleHumanMessage).not.toHaveBeenCalled();
  });
});
