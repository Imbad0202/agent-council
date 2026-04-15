// tests/telegram/stresstest-command.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCouncilMessageFromTelegram } from '../../src/telegram/handlers.js';

describe('/stresstest command', () => {
  it('createCouncilMessageFromTelegram with stressTest=true sets the field', () => {
    const fakeMessage = {
      message_id: 1,
      chat: { id: 100 },
      from: { id: 200, is_bot: false, first_name: 'User' },
      text: '/stresstest analyze this proposal',
      date: 1234567890,
    } as any;
    const msg = createCouncilMessageFromTelegram(fakeMessage, { stressTest: true });
    expect(msg.stressTest).toBe(true);
  });

  it('createCouncilMessageFromTelegram without options omits stressTest', () => {
    const fakeMessage = {
      message_id: 1,
      chat: { id: 100 },
      from: { id: 200, is_bot: false, first_name: 'User' },
      text: 'normal message',
      date: 1234567890,
    } as any;
    const msg = createCouncilMessageFromTelegram(fakeMessage);
    expect(msg.stressTest).toBeUndefined();
  });

  it('buildStressTestHandler enforces group chat, args, and stressTest flag', async () => {
    const handler = { handleHumanMessage: vi.fn() };
    const fakeCtxNoArgs: any = {
      chat: { id: 100 },
      from: { is_bot: false },
      match: '',
      reply: vi.fn(),
      message: { message_id: 1, chat: { id: 100 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/stresstest', date: 0 },
    };
    const fakeCtxWithArgs: any = {
      chat: { id: 100 },
      from: { is_bot: false },
      match: 'do the thing',
      reply: vi.fn(),
      message: { message_id: 2, chat: { id: 100 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/stresstest do the thing', date: 0 },
    };
    const fakeCtxWrongChat: any = {
      chat: { id: 999 },
      from: { is_bot: false },
      match: 'do the thing',
      reply: vi.fn(),
      message: { message_id: 3, chat: { id: 999 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/stresstest do the thing', date: 0 },
    };

    const { buildStressTestHandler } = await import('../../src/telegram/bot.js');
    const fn = buildStressTestHandler(100, handler);

    await fn(fakeCtxNoArgs);
    expect(handler.handleHumanMessage).not.toHaveBeenCalled();
    expect(fakeCtxNoArgs.reply).toHaveBeenCalled();

    await fn(fakeCtxWithArgs);
    expect(handler.handleHumanMessage).toHaveBeenCalledTimes(1);
    const passedMsg = handler.handleHumanMessage.mock.calls[0][0];
    expect(passedMsg.stressTest).toBe(true);

    await fn(fakeCtxWrongChat);
    expect(handler.handleHumanMessage).toHaveBeenCalledTimes(1); // unchanged from previous assertion — ignored due to wrong chat
  });
});
