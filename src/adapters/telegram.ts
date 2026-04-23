import { BotManager } from '../telegram/bot.js';
import type {
  BlindReviewWiring,
  PvgRotateWiring,
  CritiqueUiWiring,
  SessionResetWiring,
} from '../telegram/bot.js';
import { InlineKeyboard } from 'grammy';
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

export class TelegramAdapter implements InputAdapter, OutputAdapter {
  private botManager: BotManager;
  private config: TelegramAdapterConfig;
  private blindReviewWiring: BlindReviewWiring | undefined;
  private pvgRotateWiring: PvgRotateWiring | undefined;
  private critiqueWiring: HumanCritiqueWiring | undefined;
  private critiqueUiWiring: CritiqueUiWiring | undefined;
  private sessionResetWiring: SessionResetWiring | undefined;

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

  async handleCritiqueRequest(req: CritiqueRequest): Promise<void> {
    await dispatchCritiqueRequest(this.critiqueWiring, req);
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
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
      },
    );
    await listenerBot.api.deleteWebhook({ drop_pending_updates: true });
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
    await listenerBot.start({ drop_pending_updates: true, onStart: () => console.log('Telegram adapter running.') });
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
    const listenerBot = this.botManager.getListenerBot();
    await listenerBot.stop();
  }
}
