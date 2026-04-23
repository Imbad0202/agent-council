import { describe, it, expect } from 'vitest';
import { buildRealHandler } from '../helpers/deliberation-factory.js';
import { makeMessage } from '../council/helpers.js';

const THREAD = 42;

async function runOneRound(
  bus: ReturnType<typeof buildRealHandler>['bus'],
  content: string,
): Promise<void> {
  const done = new Promise<void>((resolve) => {
    bus.on('deliberation.ended', () => resolve());
  });
  bus.emit('intent.classified', {
    intent: 'deliberation',
    complexity: 'medium',
    threadId: THREAD,
    message: makeMessage(content, THREAD),
  });
  await done;
}

const KNOWN_SUMMARY = [
  '## Decisions',
  '- choose rust over go for the data plane',
  '',
  '## Open Questions',
  '- how do we measure throughput?',
  '',
  '## Evidence Pointers',
  '- turn 3: benchmarks cited',
  '',
  '## Blind-Review State',
  'none',
  '',
].join('\n');

// The exact text AgentWorker.respond prepends when snapshotPrefix is set.
// Source: src/worker/agent-worker.ts:72-76.
const PREPEND_HEADER = 'Prior segment summary (from /councilreset):';

describe('Reset flow — provider-agnostic carry-forward', () => {
  it('both claude and openai agents see the snapshot at messages[0] on the next turn', async () => {
    const { bus, sessionReset, handler, providers } = buildRealHandler({
      facilitatorSummary: KNOWN_SUMMARY,
      agentResponse: 'agent-said-something',
    });

    // Segment 0: seed history so reset has something to summarise.
    await runOneRound(bus, 'should we ship rust or go?');

    // Snapshot pre-reset call counts so we can identify the post-reset calls.
    const claudeCallsBefore = providers.claude.calls.length;
    const openaiCallsBefore = providers.openai.calls.length;
    const facilitatorCallsBefore = providers.facilitator.calls.length;

    // Reset.
    await sessionReset.reset(handler as never, THREAD);

    // Segment 1: one more round. Agents should now see the snapshot at messages[0].
    await runOneRound(bus, 'what about coverage strategy?');

    // Each agent was called exactly once in the pre-reset round and at least
    // once in the post-reset round. The FIRST post-reset call is the one we
    // care about — it must start with the snapshot prefix.
    expect(providers.claude.calls.length).toBeGreaterThan(claudeCallsBefore);
    expect(providers.openai.calls.length).toBeGreaterThan(openaiCallsBefore);

    const claudePostReset = providers.claude.calls[claudeCallsBefore];
    const openaiPostReset = providers.openai.calls[openaiCallsBefore];

    // Provider-agnostic guarantee: messages[0] is a user-role message
    // carrying the reset summary on BOTH providers.
    expect(claudePostReset.messages[0].role).toBe('user');
    expect(claudePostReset.messages[0].content).toContain(PREPEND_HEADER);
    expect(claudePostReset.messages[0].content).toContain(
      'choose rust over go for the data plane',
    );

    expect(openaiPostReset.messages[0].role).toBe('user');
    expect(openaiPostReset.messages[0].content).toContain(PREPEND_HEADER);
    expect(openaiPostReset.messages[0].content).toContain(
      'choose rust over go for the data plane',
    );

    // The facilitator also ran during the reset itself (respondDeterministic)
    // plus its normal round-end summary call. The reset call must NOT have
    // contained the prior snapshot (no prior snapshot existed yet at that
    // point, but the invariant holds going forward as well).
    expect(providers.facilitator.calls.length).toBeGreaterThan(facilitatorCallsBefore);
  });

  it('pre-reset round has NO snapshot prefix (segment 0 is clean)', async () => {
    const { bus, providers } = buildRealHandler({
      facilitatorSummary: KNOWN_SUMMARY,
    });

    await runOneRound(bus, 'first round question');

    // With no prior reset, getSnapshotPrefix returns null → worker.respond
    // does NOT prepend anything.
    expect(providers.claude.calls.length).toBeGreaterThan(0);
    expect(providers.openai.calls.length).toBeGreaterThan(0);

    for (const call of providers.claude.calls) {
      expect(call.messages[0].content).not.toContain(PREPEND_HEADER);
    }
    for (const call of providers.openai.calls) {
      expect(call.messages[0].content).not.toContain(PREPEND_HEADER);
    }
  });

  it('SessionReset facilitator call does not receive a snapshot prefix on the first reset', async () => {
    const { bus, sessionReset, handler, providers } = buildRealHandler({
      facilitatorSummary: KNOWN_SUMMARY,
    });

    await runOneRound(bus, 'seed message');

    const facilitatorCallsBefore = providers.facilitator.calls.length;

    await sessionReset.reset(handler as never, THREAD);

    // Reset triggers at least one facilitator call (respondDeterministic).
    expect(providers.facilitator.calls.length).toBeGreaterThan(facilitatorCallsBefore);

    // The reset's respondDeterministic call is whichever facilitator call
    // fired between before and now (there may be multiple — round-end summary
    // uses the same stub). None of them on the FIRST reset can carry a
    // snapshot prefix, because there is no prior snapshot on segment 0.
    for (let i = facilitatorCallsBefore; i < providers.facilitator.calls.length; i++) {
      const call = providers.facilitator.calls[i];
      expect(call.messages[0]?.content ?? '').not.toContain(PREPEND_HEADER);
    }
  });
});
