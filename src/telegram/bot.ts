import { Bot, Context, InlineKeyboard } from 'grammy';
import { createCouncilMessageFromTelegram, resolveTelegramThreadId } from './handlers.js';
import type { AgentConfig, CouncilMessage } from '../types.js';
import { BlindReviewStore, formatRevealMessage } from '../council/blind-review.js';
import type { BlindReviewDB } from '../council/blind-review-db.js';
import type { EventBus } from '../events/bus.js';
import type { SessionReset, HandlerForReset } from '../council/session-reset.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { AdversarialMode, AdversarialRole } from '../council/adversarial-provers.js';
import { formatGuessReveal, ROTATION_CALLBACK_PATTERN } from '../council/pvg-rotate.js';
import { formatAdversarialDebrief } from '../council/adversarial-provers.js';
import type { PvgRotateStore } from '../council/pvg-rotate-store.js';
import type { PvgRotateDB } from '../council/pvg-rotate-db.js';
import { emptyPvgRotateStats } from '../council/pvg-rotate-db.js';
import type { PendingCritiqueState } from './critique-state.js';
import {
  CRITIQUE_CALLBACK_PATTERN,
  CRITIQUE_PROMPT_AGENT_ID,
  buildCritiqueCallback,
  buildCritiqueTextHandler,
} from './critique-callback.js';
import { randomUUID } from 'node:crypto';

export interface BlindReviewWiring {
  store: BlindReviewStore;
  sendFn: (agentId: string, content: string, threadId?: number) => Promise<void>;
  agentMeta: Map<string, { name: string; role: string }>;
  bus?: EventBus;
  db?: BlindReviewDB;
  modelConfigForAgent?: (agentId: string) => { low: string; medium: string; high: string } | null;
}

export interface PvgRotateWiring {
  store: PvgRotateStore;
  db?: PvgRotateDB;
  sendFn: (agentId: string, content: string, threadId?: number) => Promise<void>;
  bus?: EventBus;
}

export interface CritiqueUiWiring {
  state: PendingCritiqueState;
  sendFn?: (agentId: string, content: string, threadId?: number) => Promise<void>;
}

export interface SessionResetWiring {
  reset: SessionReset;
  deliberationHandler: HandlerForReset;
  db: ResetSnapshotDB;
}

type CommandFlag =
  | { stressTest: true }
  | { blindReview: true }
  | { adversarialMode: AdversarialMode }
  | { pvgRotate: true };

function buildCommandHandler(
  groupChatId: number,
  usageText: string,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
  flag: CommandFlag,
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (ctx.from?.is_bot) return;
    const message = ctx.match?.toString().trim() ?? '';
    if (!message) {
      await ctx.reply(usageText);
      return;
    }
    if (!ctx.message) return;
    const councilMsg = createCouncilMessageFromTelegram(ctx.message, flag);
    handler.handleHumanMessage(councilMsg);
  };
}

export function buildStressTestHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
) {
  return buildCommandHandler(
    groupChatId,
    'Usage: /stresstest <your question>\nOne agent will play sneaky-prover (planted plausible error) so you can practice spotting it.',
    handler,
    { stressTest: true },
  );
}

const PVG_MODE_DESCRIPTIONS: Record<AdversarialMode, string> = {
  biased: 'one agent will play biased-prover (cognitive-bias framing)',
  deceptive: 'one agent will play deceptive-prover (conclusion/evidence mismatch)',
  calibrated: 'one agent will play calibrated-prover (declared confidence + unknown)',
};

export function buildPvgTestHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
  mode: AdversarialMode,
) {
  return buildCommandHandler(
    groupChatId,
    `Usage: /pvg${mode} <your question>\n${PVG_MODE_DESCRIPTIONS[mode]}.`,
    handler,
    { adversarialMode: mode },
  );
}

export function buildPvgRotateHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
) {
  return buildCommandHandler(
    groupChatId,
    'Usage: /pvgrotate <your question>\nOne agent will play a random PVG role (sneaky/biased/deceptive/calibrated-honest). You identify which one blind.',
    handler,
    { pvgRotate: true },
  );
}

export function buildBlindReviewHandler(
  groupChatId: number,
  handler: { handleHumanMessage: (msg: CouncilMessage) => void },
) {
  return buildCommandHandler(
    groupChatId,
    'Usage: /blindreview <your topic>\nAgents respond anonymously (Agent-A, Agent-B, ...). You score each one before identities are revealed.',
    handler,
    { blindReview: true },
  );
}

export function buildCancelReviewHandler(
  groupChatId: number,
  store: BlindReviewStore,
  bus?: EventBus,
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (ctx.from?.is_bot) return;
    const threadId = resolveTelegramThreadId(ctx.message);
    const session = store.get(threadId);
    if (!session) {
      await ctx.reply('No blind-review session in progress for this thread.');
      return;
    }
    store.delete(threadId);
    // Round-8 codex finding [P2]: DeliberationHandler tracks an independent
    // blindReviewSessionId on SessionState that /councilreset reads. Without
    // this emit, the field stays non-null for the life of the process and
    // /councilreset keeps refusing the thread forever after a cancel.
    bus?.emit('blind-review.cancelled', { threadId });
    await ctx.reply('Blind-review session cancelled.');
  };
}

export function buildCouncilResetHandler(groupChatId: number, wiring: SessionResetWiring) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (ctx.from?.is_bot) return;
    const threadId = resolveTelegramThreadId(ctx.message);
    try {
      const result = await wiring.reset.reset(wiring.deliberationHandler, threadId);
      await ctx.reply(
        `Sealed segment ${result.segmentIndex}: ${result.metadata.decisionsCount} decision(s), ${result.metadata.openQuestionsCount} open question(s). Starting next segment.`,
      );
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  };
}

export function buildCouncilHistoryHandler(groupChatId: number, db: ResetSnapshotDB) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (ctx.from?.is_bot) return;
    const threadId = resolveTelegramThreadId(ctx.message);
    const snapshots = db.listSnapshotsForThread(threadId);
    if (snapshots.length === 0) {
      await ctx.reply('No resets yet in this session.');
      return;
    }
    const lines = snapshots.map(
      (s) =>
        `[${s.segmentIndex}] ${s.sealedAt} — ${s.metadata.decisionsCount} decisions, ${s.metadata.openQuestionsCount} open`,
    );
    await ctx.reply(lines.join('\n'));
  };
}

export function buildBlindReviewCallback(
  groupChatId: number,
  store: BlindReviewStore,
  sendFn: (agentId: string, content: string, threadId?: number) => Promise<void>,
  agentMeta: Map<string, { name: string; role: string }>,
  bus?: EventBus,
  db?: BlindReviewDB,
  modelConfigForAgent?: (agentId: string) => { low: string; medium: string; high: string } | null,
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (!ctx.match || !Array.isArray(ctx.match)) return;
    const code = ctx.match[1];
    const score = parseInt(ctx.match[2], 10);
    const threadId = ctx.message?.message_thread_id ?? ctx.chat.id;

    const result = store.recordScore(threadId, code, score);
    if ('error' in result) {
      await ctx.answerCallbackQuery({ text: result.error });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Recorded ${score}★ for ${code}` });
    bus?.emit('blind-review.scored', { threadId, code, score, allScored: result.allScored });

    if (result.allScored) {
      const session = store.get(threadId);
      if (session) {
        const reveal = formatRevealMessage(session, agentMeta, { db, modelConfigForAgent });
        await sendFn('blind-review-reveal', reveal, threadId);
        store.markRevealed(threadId);
        bus?.emit('blind-review.revealed', { threadId });
      }
    }
  };
}

export function buildPvgRotateCallback(
  groupChatId: number,
  store: PvgRotateStore,
  db: PvgRotateDB | undefined,
  sendFn: (agentId: string, content: string, threadId?: number) => Promise<void>,
  bus?: EventBus,
) {
  return async (ctx: Context) => {
    if (ctx.chat?.id !== groupChatId) return;
    if (!ctx.match || !Array.isArray(ctx.match)) return;
    const guessedRole = ctx.match[1] as AdversarialRole;
    const threadId = ctx.message?.message_thread_id ?? ctx.chat.id;

    const session = store.get(threadId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'no pvg-rotate session for this thread' });
      return;
    }
    const result = store.recordGuess(threadId, guessedRole);
    if ('error' in result) {
      await ctx.answerCallbackQuery({ text: result.error });
      return;
    }
    await ctx.answerCallbackQuery({ text: result.correct ? '✅' : '❌' });

    let stats = emptyPvgRotateStats();
    if (db) {
      try {
        db.recordGuess({
          roundId: randomUUID(),
          threadId,
          plantedRole: result.plantedRole,
          guessedRole,
          startedAt: new Date(session.startedAt).toISOString(),
          guessedAt: new Date().toISOString(),
        });
        stats = db.getStats(threadId);
      } catch (err) {
        bus?.emit('pvg-rotate.persist-failed', {
          threadId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    const debriefLine = session.plantedDebrief
      ? formatAdversarialDebrief(session.plantedDebrief)
      : '(debrief unavailable)';
    const reveal = formatGuessReveal({
      plantedRole: result.plantedRole,
      guessedRole,
      debriefLine,
      stats,
    });
    await sendFn('pvg-rotate-reveal', reveal, threadId);
    store.delete(threadId);
    bus?.emit('pvg-rotate.revealed', { threadId, correct: result.correct });
  };
}

interface MultiBotConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}

export class BotManager {
  private bots: Map<string, Bot> = new Map();
  private groupChatId: number;
  private listenerAgentId: string;

  constructor(config: MultiBotConfig) {
    this.groupChatId = config.groupChatId;
    this.listenerAgentId = config.listenerAgentId || config.agents[0]?.id || '';

    for (const agent of config.agents) {
      const tokenEnv = agent.botTokenEnv;
      const token = tokenEnv ? process.env[tokenEnv] : process.env['TELEGRAM_BOT_TOKEN'];
      if (token) {
        this.bots.set(agent.id, new Bot(token));
      }
    }

    // Fallback: if no per-agent tokens, use single TELEGRAM_BOT_TOKEN for all
    if (this.bots.size === 0) {
      const fallbackToken = process.env['TELEGRAM_BOT_TOKEN'];
      if (fallbackToken) {
        const fallbackBot = new Bot(fallbackToken);
        for (const agent of config.agents) {
          this.bots.set(agent.id, fallbackBot);
        }
      }
    }
  }

  setupListener(
    handler: { handleHumanMessage: (msg: CouncilMessage) => void },
    wiring: {
      blindReview?: BlindReviewWiring;
      pvgRotate?: PvgRotateWiring;
      critiqueUi?: CritiqueUiWiring;
      sessionReset?: SessionResetWiring;
    } = {},
  ): void {
    const { blindReview, pvgRotate, critiqueUi, sessionReset } = wiring;
    const listenerBot = this.bots.get(this.listenerAgentId);
    if (!listenerBot) {
      throw new Error(`Listener bot not found for agent: ${this.listenerAgentId}`);
    }

    listenerBot.command('stresstest', buildStressTestHandler(this.groupChatId, handler));
    listenerBot.command('pvgbiased', buildPvgTestHandler(this.groupChatId, handler, 'biased'));
    listenerBot.command('pvgdeceptive', buildPvgTestHandler(this.groupChatId, handler, 'deceptive'));
    listenerBot.command('pvgcalibrated', buildPvgTestHandler(this.groupChatId, handler, 'calibrated'));
    listenerBot.command('pvgrotate', buildPvgRotateHandler(this.groupChatId, handler));

    // Round-8 codex finding [P1]: grammY runs middleware in registration
    // order and `on('message:text', ...)` consumes `/command` updates unless
    // it calls `next()`. Register every command BEFORE the catch-all text
    // handler so Telegram doesn't feed `/councilreset` / `/blindreview`
    // into the deliberation as ordinary text.
    if (sessionReset) {
      listenerBot.command('councilreset', buildCouncilResetHandler(this.groupChatId, sessionReset));
      listenerBot.command('councilhistory', buildCouncilHistoryHandler(this.groupChatId, sessionReset.db));
    }

    if (blindReview) {
      listenerBot.command('blindreview', buildBlindReviewHandler(this.groupChatId, handler));
      listenerBot.command('cancelreview', buildCancelReviewHandler(this.groupChatId, blindReview.store, blindReview.bus));
      listenerBot.callbackQuery(/^br-score:([^:]+):(\d)$/, buildBlindReviewCallback(
        this.groupChatId,
        blindReview.store,
        blindReview.sendFn,
        blindReview.agentMeta,
        blindReview.bus,
        blindReview.db,
        blindReview.modelConfigForAgent,
      ));
    }

    if (pvgRotate) {
      listenerBot.callbackQuery(
        ROTATION_CALLBACK_PATTERN,
        buildPvgRotateCallback(
          this.groupChatId,
          pvgRotate.store,
          pvgRotate.db,
          pvgRotate.sendFn,
          pvgRotate.bus,
        ),
      );
    }

    if (critiqueUi) {
      const configuredSendFn = critiqueUi.sendFn;
      const followUpSend = configuredSendFn
        ? (text: string, threadId: number) =>
            configuredSendFn(CRITIQUE_PROMPT_AGENT_ID, text, threadId)
        : async () => {};
      listenerBot.callbackQuery(
        CRITIQUE_CALLBACK_PATTERN,
        buildCritiqueCallback(this.groupChatId, critiqueUi.state, followUpSend),
      );
    }

    // Register the catch-all text handler LAST so all command handlers above
    // get first crack at matching `/command` updates (round-8 codex finding).
    const defaultTextHandler = async (ctx: Context) => {
      if (ctx.chat?.id !== this.groupChatId) return;
      if (ctx.from?.is_bot) return;
      if (!ctx.message) return;
      const councilMsg = createCouncilMessageFromTelegram(ctx.message);
      handler.handleHumanMessage(councilMsg);
    };

    if (critiqueUi) {
      listenerBot.on('message:text', buildCritiqueTextHandler(
        this.groupChatId,
        critiqueUi.state,
        defaultTextHandler,
      ));
    } else {
      listenerBot.on('message:text', defaultTextHandler);
    }
  }

  private splitMessage(text: string, maxLength = 4096): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      // Try to split at last newline within limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) splitAt = maxLength;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }

  async sendMessage(agentId: string, agentName: string, content: string, threadId?: number): Promise<void> {
    const bot = this.bots.get(agentId);
    const opts = threadId ? { message_thread_id: threadId } : {};

    if (!bot) {
      // Fallback to any available bot
      const fallbackBot = this.bots.values().next().value;
      if (!fallbackBot) return;
      const formatted = `🤖 ${agentName}\n\n${content}`;
      for (const chunk of this.splitMessage(formatted)) {
        await fallbackBot.api.sendMessage(this.groupChatId, chunk, opts);
      }
      return;
    }

    // When using per-agent bots, no need for name prefix — bot identity IS the name
    for (const chunk of this.splitMessage(content)) {
      await bot.api.sendMessage(this.groupChatId, chunk, opts);
    }
  }

  async sendMessageWithKeyboard(
    agentId: string,
    content: string,
    keyboard: InlineKeyboard,
    threadId?: number,
  ): Promise<void> {
    const bot = this.bots.get(agentId) ?? this.bots.values().next().value;
    if (!bot) return;
    const opts: { reply_markup: InlineKeyboard; message_thread_id?: number } = {
      reply_markup: keyboard,
    };
    if (threadId) opts.message_thread_id = threadId;
    await bot.api.sendMessage(this.groupChatId, content, opts);
  }

  getListenerBot(): Bot {
    const bot = this.bots.get(this.listenerAgentId);
    if (!bot) throw new Error(`Listener bot not found: ${this.listenerAgentId}`);
    return bot;
  }

  getBotCount(): number {
    return this.bots.size;
  }

  getAgentIds(): string[] {
    return [...this.bots.keys()];
  }
}
