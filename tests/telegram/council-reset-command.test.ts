import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCouncilResetHandler,
  buildCouncilHistoryHandler,
} from '../../src/telegram/bot.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { SessionReset } from '../../src/council/session-reset.js';

const GROUP = 100;
const THREAD = 555;

function makeDelibHandler(overrides: Partial<{
  blindReviewSessionId: string | null;
  resetInFlight: boolean;
  deliberationInFlight: boolean;
}> = {}) {
  return {
    getBlindReviewSessionId: vi.fn(() => overrides.blindReviewSessionId ?? null),
    getCurrentTopic: vi.fn(() => 'topic'),
    // Non-empty so round-10 empty-segment guard doesn't short-circuit.
    // Sentinel content is greppable for future maintainers.
    getCurrentSegmentMessages: vi.fn(() => [{ id: 'x', role: 'human', content: 'TEST_DEFAULT_TURN_ROUND10_GUARD', timestamp: 1 }] as readonly unknown[]),
    getSegments: vi.fn(() => [{ snapshotId: null }]),
    isResetInFlight: vi.fn(() => overrides.resetInFlight ?? false),
    isDeliberationInFlight: vi.fn(() => overrides.deliberationInFlight ?? false),
    setResetInFlight: vi.fn(),
    sealCurrentSegment: vi.fn(),
    openNewSegment: vi.fn(),
    unsealCurrentSegment: vi.fn(),
  };
}

function makeFacilitator(content: string) {
  return {
    respondDeterministic: vi.fn(async () => ({
      content,
      tokensUsed: { input: 1, output: 1 },
    })),
  };
}

const VALID_SUMMARY = [
  '## Decisions',
  '- a',
  '',
  '## Open Questions',
  '- q',
  '',
  '## Evidence Pointers',
  '- e',
  '',
  '## Blind-Review State',
  'none',
  '',
].join('\n');

function makeCtx(chatId: number, threadId: number | 'none' = THREAD) {
  const message = threadId === 'none' ? {} : { message_thread_id: threadId };
  return {
    chat: { id: chatId },
    from: { is_bot: false },
    message,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// DBs created per-test; tracked here so an afterEach can close any that a
// failing test forgot to clean up. In-memory SQLite leaks are small, but the
// habit keeps the test process tidy.
const openDbs: ResetSnapshotDB[] = [];
function trackDb(db: ResetSnapshotDB): ResetSnapshotDB {
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    try { db?.close(); } catch { /* already closed */ }
  }
});

describe('/councilreset Telegram', () => {
  it('seals segment and replies with confirmation in the correct group + thread', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const reset = new SessionReset(db, facilitator as never);
    const delib = makeDelibHandler();
    const fn = buildCouncilResetHandler(GROUP, {
      reset,
      deliberationHandler: delib as never,
      db,
    });

    const ctx = makeCtx(GROUP);
    await fn(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toMatch(/^Sealed segment 0: 1 decision/);
    expect(delib.sealCurrentSegment).toHaveBeenCalledWith(THREAD, expect.any(String));
  });

  it('replies with BlindReviewActiveError message when blind-review is pending', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const reset = new SessionReset(db, facilitator as never);
    const delib = makeDelibHandler({ blindReviewSessionId: 'br-active' });
    const fn = buildCouncilResetHandler(GROUP, {
      reset,
      deliberationHandler: delib as never,
      db,
    });

    const ctx = makeCtx(GROUP);
    await fn(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('/blindreview reveal');
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
  });

  it('ignores messages from the wrong group chat', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const reset = new SessionReset(db, facilitator as never);
    const delib = makeDelibHandler();
    const fn = buildCouncilResetHandler(GROUP, {
      reset,
      deliberationHandler: delib as never,
      db,
    });

    const ctx = makeCtx(999);
    await fn(ctx as never);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
  });

  it('ignores messages from bots', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const reset = new SessionReset(db, facilitator as never);
    const delib = makeDelibHandler();
    const fn = buildCouncilResetHandler(GROUP, {
      reset,
      deliberationHandler: delib as never,
      db,
    });

    const ctx: ReturnType<typeof makeCtx> = makeCtx(GROUP);
    ctx.from = { is_bot: true };
    await fn(ctx as never);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  // Round-9 codex finding [P1]: non-forum (no topics) Telegram chats set
  // message_thread_id = undefined, and normal user messages get normalized
  // to threadId = 0 by GatewayRouter. Command handlers used to fall back to
  // `ctx.chat.id` which meant /councilreset summarized the WRONG thread key
  // in every non-forum group — always empty, because the actual deliberation
  // lived under threadId 0.
  it('normalizes missing message_thread_id to 0 (matches GatewayRouter), not chat.id', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const reset = new SessionReset(db, facilitator as never);
    const delib = makeDelibHandler();
    const fn = buildCouncilResetHandler(GROUP, {
      reset,
      deliberationHandler: delib as never,
      db,
    });

    const ctx = makeCtx(GROUP, 'none');
    await fn(ctx as never);

    expect(delib.sealCurrentSegment).toHaveBeenCalledWith(0, expect.any(String));
    expect(delib.sealCurrentSegment).not.toHaveBeenCalledWith(GROUP, expect.any(String));
  });
});

describe('/councilhistory Telegram', () => {
  it('replies "no resets yet" when empty', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const fn = buildCouncilHistoryHandler(GROUP, db);

    const ctx = makeCtx(GROUP);
    await fn(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith('No resets yet in this session.');
  });

  it('replies with a newline-joined list of snapshots', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    db.recordSnapshot({
      snapshotId: 'snap-0',
      threadId: THREAD,
      segmentIndex: 0,
      sealedAt: '2026-04-23T09:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 1, openQuestionsCount: 1, blindReviewSessionId: null },
    });
    db.recordSnapshot({
      snapshotId: 'snap-1',
      threadId: THREAD,
      segmentIndex: 1,
      sealedAt: '2026-04-23T10:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 3, openQuestionsCount: 0, blindReviewSessionId: null },
    });

    const fn = buildCouncilHistoryHandler(GROUP, db);
    const ctx = makeCtx(GROUP);
    await fn(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const body = String(ctx.reply.mock.calls[0][0]);
    const lines = body.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[0]');
    expect(lines[0]).toContain('1 decisions');
    expect(lines[1]).toContain('[1]');
    expect(lines[1]).toContain('3 decisions');
  });

  it('ignores wrong group chat', async () => {
    const db = trackDb(new ResetSnapshotDB(':memory:'));
    const fn = buildCouncilHistoryHandler(GROUP, db);

    const ctx = makeCtx(999);
    await fn(ctx as never);

    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
