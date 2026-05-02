import { BotManager } from '../telegram/bot.js';
import type {
  BlindReviewWiring,
  PvgRotateWiring,
  CritiqueUiWiring,
  SessionResetWiring,
  ArtifactWiring,
} from '../telegram/bot.js';
import { InlineKeyboard } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type { AgentConfig, CouncilMessage } from '../types.js';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';
import {
  dispatchCritiqueRequest,
  type HumanCritiqueWiring,
  type CritiqueRequest,
} from '../council/human-critique-wiring.js';

export interface TelegramAdapterConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}

// Narrow structural interface so src/index.ts can feature-detect the Telegram
// critique UI path without importing the full TelegramAdapter class. Rename
// the method on the class and this breaks at compile time.
export interface CritiqueUiAdapter {
  setCritiqueUiWiring(wiring: CritiqueUiWiring): void;
}

// Same pattern for /councilreset wiring — index.ts feature-detects this
// narrow shape before passing the SessionResetWiring payload.
export interface SessionResetAdapter {
  setSessionResetWiring(wiring: SessionResetWiring): void;
}

// Same pattern for /councildone + /councilshow wiring.
export interface ArtifactAdapter {
  setArtifactWiring(wiring: ArtifactWiring): void;
}

export class TelegramAdapter implements InputAdapter, OutputAdapter {
  private botManager: BotManager;
  private config: TelegramAdapterConfig;
  private blindReviewWiring: BlindReviewWiring | undefined;
  private pvgRotateWiring: PvgRotateWiring | undefined;
  private critiqueWiring: HumanCritiqueWiring | undefined;
  private critiqueUiWiring: CritiqueUiWiring | undefined;
  private sessionResetWiring: SessionResetWiring | undefined;
  private artifactWiring: ArtifactWiring | undefined;
  private runner: RunnerHandle | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
    this.botManager = new BotManager({
      groupChatId: config.groupChatId,
      agents: config.agents,
      listenerAgentId: config.listenerAgentId,
    });
  }

  setBlindReviewWiring(wiring: unknown): void {
    this.blindReviewWiring = wiring as BlindReviewWiring;
  }

  setPvgRotateWiring(wiring: unknown): void {
    this.pvgRotateWiring = wiring as PvgRotateWiring;
  }

  setHumanCritiqueWiring(wiring: unknown): void {
    this.critiqueWiring = wiring as HumanCritiqueWiring;
  }

  setCritiqueUiWiring(wiring: CritiqueUiWiring): void {
    this.critiqueUiWiring = {
      state: wiring.state,
      sendFn: wiring.sendFn ?? ((agentId, content, threadId) =>
        this.botManager.sendMessage(agentId, 'Council', content, threadId)),
    };
  }

  setSessionResetWiring(wiring: unknown): void {
    this.sessionResetWiring = wiring as SessionResetWiring;
  }

  setArtifactWiring(wiring: unknown): void {
    this.artifactWiring = wiring as ArtifactWiring;
  }

  async handleCritiqueRequest(req: CritiqueRequest): Promise<void> {
    await dispatchCritiqueRequest(this.critiqueWiring, req);
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    // [round-9 P2-r9-1] Race-safe double-start guard. Synchronous assignment
    // of startPromise BEFORE any await means concurrent start() calls share
    // the same promise; second caller awaits the first's startup instead of
    // re-running setupListener + run(). Match bot.start()'s previous
    // no-op-on-already-running contract.
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner(onMessage);
    // [round-10 P2-r10-2] Failed-start cleanup: clear cached promise on
    // rejection so a future start() can retry. Without this, a transient
    // network failure during deleteWebhook or conflict-retry leaves the
    // adapter permanently un-startable.
    this.startPromise.catch(() => {
      if (this.startPromise && this.runner === undefined) {
        this.startPromise = undefined;
      }
    });
    return this.startPromise;
  }

  private async startInner(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    const listenerBot = this.botManager.getListenerBot();
    this.botManager.setupListener(
      {
        handleHumanMessage: (councilMsg: CouncilMessage) => {
          onMessage({ content: councilMsg.content, threadId: councilMsg.threadId });
        },
      },
      {
        blindReview: this.blindReviewWiring,
        pvgRotate: this.pvgRotateWiring,
        critiqueUi: this.critiqueUiWiring,
        sessionReset: this.sessionResetWiring,
        artifact: this.artifactWiring,
      },
    );
    await listenerBot.api.deleteWebhook({ drop_pending_updates: true });

    // Pre-startup conflict-retry: existing 6-attempt loop preserved verbatim.
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await listenerBot.api.raw.getUpdates({ offset: -1, limit: 1, timeout: 1 });
        console.log('Polling slot acquired.');
        break;
      } catch (err: unknown) {
        const isConflict = err instanceof Error && err.message.includes('409');
        if (isConflict && attempt < 6) {
          console.log(`  Stale connection (attempt ${attempt}/6), waiting 5s...`);
          await new Promise((r) => setTimeout(r, 5_000));
        } else if (!isConflict) {
          break;
        } else {
          console.log('  Could not acquire clean slot, starting anyway...');
        }
      }
    }

    // [v0.5.4 §3.5 Step 5] Install grammY-standard error boundary BEFORE run().
    // Catches errors thrown by command handlers, middleware, and update
    // dispatch. Reset/cancel-specific errors are already handled inside their
    // handlers (§4.8/§4.9); this catches anything that escapes those.
    // grammy.dev/guide/errors documents this pattern for runner mode.
    listenerBot.catch((err) => {
      console.error('Telegram bot error:', err);
    });

    // [v0.5.4 §3.5 Step 2 / round-7 brainstorm O3] Replace bot.start() with
    // run(bot). Concurrent dispatch is the default (grammy.dev/plugins/runner).
    // RunnerOptions has no drop_pending_updates option (round-5 P1-r5-1
    // verified grammy.dev/ref/runner/runneroptions); pending-update dropping
    // is already handled by deleteWebhook above.
    // start() FAST-RESOLVES like CLI's readline (cli.ts:76-91). Runner's
    // polling timer keeps process alive same way readline holds stdin.
    // Do NOT await runner.task() — that would hang tests and serve no
    // production caller (main() at index.ts:411 has nothing after the await).
    this.runner = run(listenerBot);
    console.log('Telegram adapter running (concurrent dispatch).');
  }

  async send(agentId: string, content: string, metadata: RichMetadata, threadId?: number): Promise<void> {
    await this.botManager.sendMessage(agentId, metadata.agentName, content, threadId);
  }

  async sendSystem(content: string, threadId?: number): Promise<void> {
    await this.botManager.sendMessage('system', 'System', content, threadId);
  }

  async sendMessageWithKeyboard(
    agentId: string,
    content: string,
    keyboard: unknown,
    threadId?: number,
  ): Promise<void> {
    await this.botManager.sendMessageWithKeyboard(agentId, content, keyboard as InlineKeyboard, threadId);
  }

  async stop(): Promise<void> {
    this.critiqueUiWiring?.state.drain();
    // [round-6 P1-r6-1] stop()-before-start() must be safe. Test contract
    // change (round-9 P2-r9-2): the existing telegram.test.ts:278 test is
    // updated in Task 15 to call start() first; this guard preserves
    // bot.stop()'s previous no-op-on-unstarted behavior for any caller
    // that legitimately stops before start.
    if (!this.runner) return;
    await this.runner.stop();
    // [round-9 P2-r9-1] Clear handles so a future start() can re-run.
    // Realistic restart pattern.
    this.runner = undefined;
    this.startPromise = undefined;
  }
}
