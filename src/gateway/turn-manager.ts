import type { CouncilConfig } from '../types.js';

interface QueuedResponse {
  agentId: string;
  content: string;
  enqueuedAt: number;
}

export class TurnManager {
  private config: CouncilConfig['gateway'];
  private queue: QueuedResponse[] = [];
  private _turnCount = 0;
  private _interAgentRoundCount = 0;
  private sending = false;

  constructor(config: CouncilConfig['gateway']) {
    this.config = config;
  }

  get turnCount(): number {
    return this._turnCount;
  }

  get interAgentRoundCount(): number {
    return this._interAgentRoundCount;
  }

  enqueueResponse(agentId: string, content: string): void {
    this.queue.push({ agentId, content, enqueuedAt: Date.now() });
  }

  async flushQueue(sendFn: (agentId: string, content: string) => Promise<void>): Promise<void> {
    if (this.sending) return;
    this.sending = true;

    try {
      this.queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

      for (const item of this.queue) {
        const [minDelay, maxDelay] = this.config.randomDelayMs;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));

        await sendFn(item.agentId, item.content);
      }

      this.queue = [];
    } finally {
      this.sending = false;
    }
  }

  recordHumanTurn(): void {
    this._turnCount++;
    this._interAgentRoundCount = 0;
  }

  recordAgentTurn(agentId: string): void {
    this._turnCount++;
    this._interAgentRoundCount++;
  }

  canAgentRespond(): boolean {
    return this._interAgentRoundCount < this.config.maxInterAgentRounds;
  }

  isSessionMaxReached(): boolean {
    return this._turnCount >= this.config.sessionMaxTurns;
  }

  reset(): void {
    this._turnCount = 0;
    this._interAgentRoundCount = 0;
    this.queue = [];
  }
}
