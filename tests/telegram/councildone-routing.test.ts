import { describe, it, expect, vi } from 'vitest';
import { resolveTelegramThreadId } from '../../src/telegram/handlers.js';
import {
  buildCouncilDoneHandler,
  buildCouncilShowHandler,
} from '../../src/telegram/bot.js';
import type { ArtifactWiring } from '../../src/telegram/bot.js';
import type { ArtifactRow } from '../../src/council/artifact-db.js';

const GROUP = 100;
const THREAD = 7;

function makeMockCtx(overrides: Partial<{
  chatId: number;
  isBot: boolean;
  threadId: number | undefined;
  match: string;
}> = {}) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: overrides.chatId ?? GROUP },
    from: { is_bot: overrides.isBot ?? false },
    message: overrides.threadId !== undefined
      ? { message_thread_id: overrides.threadId }
      : { message_thread_id: THREAD },
    match: overrides.match ?? '',
    reply: vi.fn(async (text: string) => { replies.push(text); }),
    _replies: replies,
  };
  return ctx;
}

function makeArtifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 'art-1',
    thread_id: THREAD,
    segment_index: 0,
    thread_local_seq: 1,
    preset: 'universal',
    content_md: '## TL;DR\n\nTest summary.\n\n## Discussion\n\nsome content',
    created_at: '2026-04-26T00:00:00Z',
    synthesis_model: 'claude-3-sonnet',
    synthesis_token_usage_json: '{}',
    ...overrides,
  };
}

// ─── resolveTelegramThreadId guard ────────────────────────────────────────────

describe('resolveTelegramThreadId', () => {
  it('reads message_thread_id from ctx.message, not chat.id', () => {
    const threadId = resolveTelegramThreadId({ message_thread_id: 42 });
    expect(threadId).toBe(42);
    // must NOT fall back to chat.id (which would be 100 in our test setup)
    expect(threadId).not.toBe(GROUP);
  });

  it('normalizes missing message_thread_id to 0', () => {
    expect(resolveTelegramThreadId(undefined)).toBe(0);
    expect(resolveTelegramThreadId({})).toBe(0);
  });
});

// ─── buildCouncilDoneHandler ──────────────────────────────────────────────────

describe('buildCouncilDoneHandler', () => {
  it('replies "not configured" when wiring has no artifactService', async () => {
    const wiring: ArtifactWiring = {};
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx();
    await handler(ctx as never);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('not configured');
  });

  it('calls synthesize with threadId + preset and replies with confirmation', async () => {
    const row = makeArtifactRow({ thread_local_seq: 3, preset: 'universal' });
    const artifactService = {
      synthesize: vi.fn(async () => row),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: 'universal' });
    await handler(ctx as never);

    expect(artifactService.synthesize).toHaveBeenCalledWith(THREAD, 'universal');
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const reply = String(ctx.reply.mock.calls[0][0]);
    expect(reply).toContain('Artifact #3');
    expect(reply).toContain('universal');
    expect(reply).toContain('/councilshow 3');
  });

  it('defaults to "universal" preset when match is empty', async () => {
    const row = makeArtifactRow();
    const artifactService = {
      synthesize: vi.fn(async () => row),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '' });
    await handler(ctx as never);

    expect(artifactService.synthesize).toHaveBeenCalledWith(THREAD, 'universal');
  });

  it('routes "decision" preset to synthesize call', async () => {
    const row = makeArtifactRow({ thread_local_seq: 1, preset: 'decision' });
    const artifactService = {
      synthesize: vi.fn(async () => row),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: 'decision' });
    await handler(ctx as never);

    expect(artifactService.synthesize).toHaveBeenCalledWith(THREAD, 'decision');
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('decision');
  });

  it('replies "unknown preset" and does NOT call synthesize for unknown preset', async () => {
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: 'bogus' });
    await handler(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('unknown preset');
    expect(artifactService.synthesize).not.toHaveBeenCalled();
  });

  it('ignores messages from wrong group chat', async () => {
    const wiring: ArtifactWiring = {};
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ chatId: 999 });
    await handler(ctx as never);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('ignores messages from bots', async () => {
    const wiring: ArtifactWiring = {};
    const handler = buildCouncilDoneHandler(GROUP, wiring);
    const ctx = makeMockCtx({ isBot: true });
    await handler(ctx as never);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ─── buildCouncilShowHandler ──────────────────────────────────────────────────

describe('buildCouncilShowHandler', () => {
  it('replies "not configured" when wiring has no artifactService', async () => {
    const wiring: ArtifactWiring = {};
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '1' });
    await handler(ctx as never);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('not configured');
  });

  it('replies usage hint for invalid id (non-numeric)', async () => {
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: 'abc' });
    await handler(ctx as never);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('/councilshow <id>');
    expect(String(ctx.reply.mock.calls[0][0])).toContain('/councilshow 3');
  });

  it('replies usage hint for id "0" (fails regex ^[1-9])', async () => {
    const artifactService = { synthesize: vi.fn(), fetchByThreadLocalSeq: vi.fn() };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '0' });
    await handler(ctx as never);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('/councilshow <id>');
  });

  it('replies "not found" when fetchByThreadLocalSeq returns null', async () => {
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(() => null),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '5' });
    await handler(ctx as never);
    expect(artifactService.fetchByThreadLocalSeq).toHaveBeenCalledWith(THREAD, 5);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('not found');
  });

  it('replies with content (using chunkMarkdown) when artifact found', async () => {
    const shortContent = '## TL;DR\n\nShort test artifact content.';
    const row = makeArtifactRow({ content_md: shortContent });
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(() => row),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '1' });
    await handler(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toBe(shortContent);
  });

  it('chunks long content into multiple replies (Telegram 4096-char limit)', async () => {
    // 5000 chars split across two calls
    const longContent = 'A'.repeat(5000);
    const row = makeArtifactRow({ content_md: longContent });
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(() => row),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ match: '2' });
    await handler(ctx as never);

    // Should have been called more than once (5000 > 4096)
    expect(ctx.reply.mock.calls.length).toBeGreaterThan(1);
    // All chunks joined = original content
    const allReplies = ctx.reply.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(allReplies).toBe(longContent);
  });

  it('ignores messages from wrong group chat', async () => {
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ chatId: 999, match: '1' });
    await handler(ctx as never);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(artifactService.fetchByThreadLocalSeq).not.toHaveBeenCalled();
  });

  it('ignores messages from bots', async () => {
    const artifactService = {
      synthesize: vi.fn(),
      fetchByThreadLocalSeq: vi.fn(),
    };
    const wiring: ArtifactWiring = { artifactService: artifactService as never };
    const handler = buildCouncilShowHandler(GROUP, wiring);
    const ctx = makeMockCtx({ isBot: true, match: '1' });
    await handler(ctx as never);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(artifactService.fetchByThreadLocalSeq).not.toHaveBeenCalled();
  });
});
