import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnManager } from '../../src/gateway/turn-manager.js';
import type { CouncilConfig } from '../../src/types.js';

const config: CouncilConfig['gateway'] = {
  thinkingWindowMs: 100,
  randomDelayMs: [10, 50],
  maxInterAgentRounds: 3,
  contextWindowTurns: 10,
  sessionMaxTurns: 20,
};

describe('TurnManager', () => {
  let manager: TurnManager;

  beforeEach(() => {
    manager = new TurnManager(config);
  });

  it('queues responses and releases them in order', async () => {
    const sent: string[] = [];
    const sendFn = async (agentId: string, content: string) => {
      sent.push(`${agentId}: ${content}`);
    };

    manager.enqueueResponse('huahua', 'I think X');
    manager.enqueueResponse('binbin', 'I think Y');

    await manager.flushQueue(sendFn);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('I think');
    expect(sent[1]).toContain('I think');
  });

  it('tracks turn count', () => {
    expect(manager.turnCount).toBe(0);
    manager.recordHumanTurn();
    expect(manager.turnCount).toBe(1);
    manager.recordAgentTurn('huahua');
    expect(manager.turnCount).toBe(2);
  });

  it('reports when session max turns is reached', () => {
    for (let i = 0; i < 20; i++) {
      manager.recordHumanTurn();
    }
    expect(manager.isSessionMaxReached()).toBe(true);
  });

  it('tracks inter-agent round count', () => {
    expect(manager.canAgentRespond()).toBe(true);
    manager.recordAgentTurn('huahua');
    manager.recordAgentTurn('binbin');
    manager.recordAgentTurn('huahua');
    expect(manager.interAgentRoundCount).toBe(3);
  });

  it('resets inter-agent count on human turn', () => {
    manager.recordAgentTurn('huahua');
    manager.recordAgentTurn('binbin');
    expect(manager.interAgentRoundCount).toBe(2);
    manager.recordHumanTurn();
    expect(manager.interAgentRoundCount).toBe(0);
  });
});
