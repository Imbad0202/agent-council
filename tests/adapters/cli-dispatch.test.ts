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

  it('routes unknown commands to handleAsync too (handleAsync decides policy)', async () => {
    // Rationale: T11 keeps dispatch dumb. handleAsync already has a sensible
    // 'not configured' fallback for commands it doesn't own, so we don't
    // duplicate a whitelist here.
    const cliCmd = { handleAsync: vi.fn().mockResolvedValue(undefined) };
    const router = { handleHumanMessage: vi.fn() };

    await routeCliInput('/somecommand', router as never, cliCmd as never, 0);

    expect(cliCmd.handleAsync).toHaveBeenCalledWith('somecommand', '');
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
