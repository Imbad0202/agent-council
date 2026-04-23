// tests/telegram/blindreview-callback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { BlindReviewStore } from '../../src/council/blind-review.js';
import { BlindReviewDB } from '../../src/council/blind-review-db.js';
import { EventBus } from '../../src/events/bus.js';

describe('br-score callback handler', () => {
  it('records score and acknowledges callback', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const store = new BlindReviewStore();
    store.create(100, ['a', 'b'], new Map([['a', 'critic'], ['b', 'advocate']]));
    const sendFn = vi.fn();
    const agentMeta = new Map([
      ['a', { name: 'AgentA', role: 'critic' }],
      ['b', { name: 'AgentB', role: 'advocate' }],
    ]);

    const ctx: any = {
      chat: { id: 100 },
      callbackQuery: { data: 'br-score:Agent-A:4' },
      match: ['br-score:Agent-A:4', 'Agent-A', '4'],
      answerCallbackQuery: vi.fn(),
      message: { message_thread_id: 100 },
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, agentMeta);
    await fn(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(store.get(100)?.scores.get('Agent-A')).toBe(4);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('triggers reveal broadcast when all scored', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const store = new BlindReviewStore();
    store.create(101, ['a'], new Map([['a', 'critic']]));
    const sendFn = vi.fn();
    const agentMeta = new Map([['a', { name: 'Solo', role: 'critic' }]]);

    const ctx: any = {
      chat: { id: 100 },
      callbackQuery: { data: 'br-score:Agent-A:5' },
      match: ['br-score:Agent-A:5', 'Agent-A', '5'],
      answerCallbackQuery: vi.fn(),
      message: { message_thread_id: 101 },
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, agentMeta);
    await fn(ctx);
    expect(sendFn).toHaveBeenCalledTimes(1);
    const broadcastContent = sendFn.mock.calls[0][1];
    expect(broadcastContent).toContain('Solo');
    expect(broadcastContent).toContain('5');
    expect(store.get(101)?.revealed).toBe(true);
  });

  it('emits blind-review.scored when score recorded', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const store = new BlindReviewStore();
    store.create(200, ['a', 'b'], new Map([['a', 'critic'], ['b', 'advocate']]));
    const sendFn = vi.fn();
    const bus = new EventBus();
    const events: any[] = [];
    bus.on('blind-review.scored', (e) => events.push(e));

    const ctx: any = {
      chat: { id: 100 },
      callbackQuery: { data: 'br-score:Agent-A:3' },
      match: ['br-score:Agent-A:3', 'Agent-A', '3'],
      answerCallbackQuery: vi.fn(),
      message: { message_thread_id: 200 },
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, new Map(), bus);
    await fn(ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ threadId: 200, code: 'Agent-A', score: 3, allScored: false });
  });

  it('passes db + modelConfigForAgent to formatRevealMessage so stats appear in reveal', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const db = new BlindReviewDB(':memory:');
    const store = new BlindReviewStore();
    store.create(300, ['a'], new Map([['a', 'critic']]));

    // Pre-seed 5 scores so stats are available
    const session = store.get(300)!;
    session.turnLog.push({ agentId: 'a', tier: 'high', model: 'gpt-4o' });
    const sessionId = `300:${session.startedAt}`;
    db.persistSession({
      sessionRow: {
        sessionId,
        threadId: 300,
        topic: null,
        agentIds: ['a'],
        startedAt: new Date(session.startedAt).toISOString(),
        revealedAt: null,
      },
      scores: [1, 2, 3, 4, 5].map((score) => ({
        sessionId,
        agentId: 'a',
        tier: 'high' as const,
        model: 'gpt-4o',
        score,
        feedbackText: null,
      })),
    });

    const sendFn = vi.fn();
    const agentMeta = new Map([['a', { name: 'Solo', role: 'critic' }]]);
    const modelConfigForAgent = vi.fn().mockReturnValue({ low: 'gpt-3.5', medium: 'gpt-4', high: 'gpt-4o' });

    const ctx: any = {
      chat: { id: 100 },
      match: ['br-score:Agent-A:4', 'Agent-A', '4'],
      answerCallbackQuery: vi.fn(),
      message: { message_thread_id: 300 },
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, agentMeta, undefined, db, modelConfigForAgent);
    await fn(ctx);

    expect(sendFn).toHaveBeenCalledTimes(1);
    const revealText: string = sendFn.mock.calls[0][1];
    // Stats line should appear (歷史) and recommendation (建議)
    expect(revealText).toContain('歷史');
    expect(revealText).toContain('建議');
  });

  it('ignores callback from wrong chat', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const store = new BlindReviewStore();
    store.create(102, ['a'], new Map([['a', 'critic']]));
    const sendFn = vi.fn();
    const agentMeta = new Map();

    const ctx: any = {
      chat: { id: 999 },
      callbackQuery: { data: 'br-score:Agent-A:5' },
      match: ['br-score:Agent-A:5', 'Agent-A', '5'],
      answerCallbackQuery: vi.fn(),
      message: { message_thread_id: 102 },
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, agentMeta);
    await fn(ctx);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(store.get(102)?.scores.size).toBe(0);
  });

  // Round-10 codex finding [P1]: in non-forum Telegram chats (no topics)
  // ctx.message.message_thread_id is undefined. The session is created under
  // thread 0 via GatewayRouter's threadId ?? 0 normalization, but the
  // callback used to fall back to ctx.chat.id and miss the stored session
  // entirely — so every score button was a no-op in common group chats.
  it('resolves threadId to 0 in non-forum chats (not ctx.chat.id)', async () => {
    const { buildBlindReviewCallback } = await import('../../src/telegram/bot.js');
    const store = new BlindReviewStore();
    // Session created under thread 0, same as GatewayRouter does for
    // ordinary text messages in non-forum groups.
    store.create(0, ['a', 'b'], new Map([['a', 'critic'], ['b', 'advocate']]));
    const sendFn = vi.fn();
    const agentMeta = new Map([
      ['a', { name: 'AgentA', role: 'critic' }],
      ['b', { name: 'AgentB', role: 'advocate' }],
    ]);

    // Ctx simulates a non-forum group button press: ctx.chat.id=100 but no
    // message_thread_id on the button's parent message.
    const ctx: any = {
      chat: { id: 100 },
      callbackQuery: { data: 'br-score:Agent-A:3' },
      match: ['br-score:Agent-A:3', 'Agent-A', '3'],
      answerCallbackQuery: vi.fn(),
      message: {}, // no message_thread_id → non-forum
    };

    const fn = buildBlindReviewCallback(100, store, sendFn, agentMeta);
    await fn(ctx);

    // Score landed under thread 0 where the session actually lives.
    expect(store.get(0)?.scores.get('Agent-A')).toBe(3);
    // The old ?? ctx.chat.id path would have looked up thread 100, missed,
    // and returned an error via answerCallbackQuery. Assert the ack path
    // took the success branch (text includes Recorded, not an error).
    const ackCall = ctx.answerCallbackQuery.mock.calls[0];
    expect(String(ackCall[0]?.text ?? '')).toMatch(/Recorded/);
  });
});
