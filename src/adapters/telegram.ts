import { BotManager } from '../telegram/bot.js';
import type { BlindReviewWiring } from '../telegram/bot.js';
import { InlineKeyboard } from 'grammy';
import type { AgentConfig, CouncilMessage } from '../types.js';
import type { InputAdapter, OutputAdapter, AdapterMessage, RichMetadata } from './types.js';

export interface TelegramAdapterConfig {
  groupChatId: number;
  agents: AgentConfig[];
  listenerAgentId: string;
}

export class TelegramAdapter implements InputAdapter, OutputAdapter {
  private botManager: BotManager;
  private config: TelegramAdapterConfig;
  private blindReviewWiring: BlindReviewWiring | undefined;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
    this.botManager = new BotManager({
      groupChatId: config.groupChatId,
      agents: config.agents,
      listenerAgentId: config.listenerAgentId,
    });
  }

  setBlindReviewWiring(wiring: BlindReviewWiring): void {
    this.blindReviewWiring = wiring;
  }

  async start(onMessage: (msg: AdapterMessage) => void): Promise<void> {
    const listenerBot = this.botManager.getListenerBot();
    this.botManager.setupListener(
      {
        handleHumanMessage: (councilMsg: CouncilMessage) => {
          onMessage({ content: councilMsg.content, threadId: councilMsg.threadId });
        },
      },
      this.blindReviewWiring,
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
    keyboard: InlineKeyboard,
    threadId?: number,
  ): Promise<void> {
    await this.botManager.sendMessageWithKeyboard(agentId, content, keyboard, threadId);
  }

  async stop(): Promise<void> {
    const listenerBot = this.botManager.getListenerBot();
    await listenerBot.stop();
  }
}
