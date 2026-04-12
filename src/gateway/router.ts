import type { EventBus } from '../events/bus.js';
import type { CouncilConfig, CouncilMessage } from '../types.js';

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;

interface SessionTimerState {
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

export class GatewayRouter {
  private bus: EventBus;
  private sendFn: SendFn;
  private config: CouncilConfig;
  private sessionTimers: Map<number, SessionTimerState> = new Map();

  constructor(bus: EventBus, sendFn: SendFn, config: CouncilConfig) {
    this.bus = bus;
    this.sendFn = sendFn;
    this.config = config;

    // Send facilitator messages to Telegram
    this.bus.on('facilitator.intervened', async (payload) => {
      await this.sendFn('facilitator', payload.content, payload.threadId);
    });

    // Clean up session on end
    this.bus.on('session.ended', (payload) => {
      this.clearInactivityTimer(payload.threadId);
      this.sessionTimers.delete(payload.threadId);
    });
  }

  handleHumanMessage(message: CouncilMessage): void {
    const threadId = message.threadId ?? 0;

    // Check for end keywords
    if (this.config.memory) {
      const lower = message.content.toLowerCase();
      const isEnd = this.config.memory.endKeywords.some((kw) => lower.includes(kw.toLowerCase()));
      if (isEnd) {
        this.bus.emit('session.ending', { threadId, trigger: 'keyword' });
        return;
      }
    }

    // Reset inactivity timer
    this.resetInactivityTimer(threadId);

    // Emit for downstream processing
    this.bus.emit('message.received', { message, threadId });
  }

  private resetInactivityTimer(threadId: number): void {
    this.clearInactivityTimer(threadId);
    if (!this.config.memory) return;
    const timerState: SessionTimerState = {
      inactivityTimer: setTimeout(() => {
        this.bus.emit('session.ending', { threadId, trigger: 'timeout' });
      }, this.config.memory.sessionTimeoutMs),
    };
    this.sessionTimers.set(threadId, timerState);
  }

  private clearInactivityTimer(threadId: number): void {
    const state = this.sessionTimers.get(threadId);
    if (state?.inactivityTimer) {
      clearTimeout(state.inactivityTimer);
    }
  }

  reset(): void {
    for (const state of this.sessionTimers.values()) {
      if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    }
    this.sessionTimers.clear();
  }
}
