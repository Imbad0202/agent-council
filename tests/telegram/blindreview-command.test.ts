// tests/telegram/blindreview-command.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCouncilMessageFromTelegram } from '../../src/telegram/handlers.js';

describe('/blindreview + /cancelreview commands', () => {
  it('createCouncilMessageFromTelegram with blindReview=true sets the field', () => {
    const fakeMessage = {
      message_id: 1,
      chat: { id: 100 },
      from: { id: 200, is_bot: false, first_name: 'User' },
      text: '/blindreview rust vs go',
      date: 1234567890,
    } as any;
    const msg = createCouncilMessageFromTelegram(fakeMessage, { blindReview: true });
    expect(msg.blindReview).toBe(true);
  });

  it('buildBlindReviewHandler enforces group chat + args + flag', async () => {
    const handler = { handleHumanMessage: vi.fn() };
    const fakeCtxNoArgs: any = {
      chat: { id: 100 }, from: { is_bot: false }, match: '',
      reply: vi.fn(),
      message: { message_id: 1, chat: { id: 100 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/blindreview', date: 0 },
    };
    const fakeCtxWithArgs: any = {
      chat: { id: 100 }, from: { is_bot: false }, match: 'rust vs go',
      reply: vi.fn(),
      message: { message_id: 2, chat: { id: 100 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/blindreview rust vs go', date: 0 },
    };
    const fakeCtxWrongChat: any = {
      chat: { id: 999 }, from: { is_bot: false }, match: 'rust vs go',
      reply: vi.fn(),
      message: { message_id: 3, chat: { id: 999 }, from: { id: 200, is_bot: false, first_name: 'U' }, text: '/blindreview rust vs go', date: 0 },
    };

    const { buildBlindReviewHandler } = await import('../../src/telegram/bot.js');
    const fn = buildBlindReviewHandler(100, handler);

    await fn(fakeCtxNoArgs);
    expect(handler.handleHumanMessage).not.toHaveBeenCalled();
    expect(fakeCtxNoArgs.reply).toHaveBeenCalled();

    await fn(fakeCtxWithArgs);
    expect(handler.handleHumanMessage).toHaveBeenCalledTimes(1);
    expect(handler.handleHumanMessage.mock.calls[0][0].blindReview).toBe(true);

    await fn(fakeCtxWrongChat);
    expect(handler.handleHumanMessage).toHaveBeenCalledTimes(1);
  });

  it('buildCancelReviewHandler deletes pending session in correct chat', async () => {
    const { BlindReviewStore } = await import('../../src/council/blind-review.js');
    const { buildCancelReviewHandler } = await import('../../src/telegram/bot.js');

    const store = new BlindReviewStore();
    store.create(100, ['a', 'b'], new Map([['a', 'critic'], ['b', 'advocate']]));
    expect(store.get(100)).toBeDefined();

    const fakeCtx: any = {
      chat: { id: 100 },
      from: { is_bot: false },
      reply: vi.fn(),
      message: { message_thread_id: 100 },
    };

    const fn = buildCancelReviewHandler(100, store);
    await fn(fakeCtx);
    expect(store.get(100)).toBeUndefined();
    expect(fakeCtx.reply).toHaveBeenCalled();
  });
});
