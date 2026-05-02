import { describe, it, expect, vi } from 'vitest';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { SynthesisInProgressError } from '../../src/council/session-reset-errors.js';
import type { CouncilMessage } from '../../src/types.js';

const T = 42;

const VALID_SUMMARY = [
  '## Decisions',
  '- ship rust',
  '',
  '## Open Questions',
  '- coverage?',
  '',
  '## Evidence Pointers',
  '- turn 4',
  '',
  '## Blind-Review State',
  'none',
  '',
].join('\n');

function makeFacilitator(summary: string) {
  return {
    respondDeterministic: vi.fn(async () => ({
      content: summary,
      tokensUsed: { input: 100, output: 50 },
    })),
  };
}

interface MutableSegment {
  startedAt: string;
  endedAt: string | null;
  messages: CouncilMessage[];
  snapshotId: string | null;
}

function makeHandler(init: {
  messages?: CouncilMessage[];
  isSynthesisInFlight?: boolean;
} = {}) {
  const defaultMessages: CouncilMessage[] = [
    { id: 'default-turn', role: 'human', content: 'TEST_DEFAULT_TURN_SYNTHESIS_GUARD', timestamp: 1 },
  ];
  const segments: MutableSegment[] = [
    {
      startedAt: '2026-04-25T09:00:00Z',
      endedAt: null,
      messages: init.messages ?? defaultMessages,
      snapshotId: null,
    },
  ];
  let resetInFlight = false;
  return {
    getCurrentSegmentMessages: vi.fn<[number], readonly CouncilMessage[]>(
      () => segments[segments.length - 1].messages,
    ),
    getSegments: vi.fn(() => segments),
    getBlindReviewSessionId: vi.fn(() => null),
    getCurrentTopic: vi.fn(() => 'rust vs go'),
    isResetInFlight: vi.fn(() => resetInFlight),
    isDeliberationInFlight: vi.fn(() => false),
    hasPendingClassifications: vi.fn(() => false),
    isSynthesisInFlight: vi.fn(() => init.isSynthesisInFlight ?? false),
    setResetInFlight: vi.fn((_: number, v: boolean) => {
      resetInFlight = v;
    }),
    sealCurrentSegment: vi.fn((_: number, id: string) => {
      const last = segments[segments.length - 1];
      last.endedAt = '2026-04-25T10:00:00Z';
      last.snapshotId = id;
    }),
    openNewSegment: vi.fn(() => {
      segments.push({
        startedAt: '2026-04-25T10:00:01Z',
        endedAt: null,
        messages: [],
        snapshotId: null,
      });
    }),
    unsealCurrentSegment: vi.fn(() => {
      const last = segments[segments.length - 1];
      last.endedAt = null;
      last.snapshotId = null;
    }),
    getCurrentResetController: vi.fn(() => null),
    setCurrentResetController: vi.fn(),
  };
}

describe('SessionReset — cross-table counter + synthesisInFlight guard', () => {
  it('cross-table counter: picks up segment_index from ArtifactDB when ResetSnapshotDB is empty', async () => {
    // ArtifactDB already has segment_index = 5 for thread 42.
    // ResetSnapshotDB is empty.
    // Expected: persisted snapshot gets segmentIndex = 6 (NOT 0 or 1 from in-memory fallback).
    const resetDb = new ResetSnapshotDB(':memory:');
    const artifactDb = new ArtifactDB(':memory:');
    artifactDb.insert({
      thread_id: T,
      segment_index: 5,
      thread_local_seq: 1,
      preset: 'universal',
      content_md: '## prior artifact',
      created_at: '2026-04-25T08:00:00Z',
    });

    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({
      messages: [{ id: 'm1', role: 'human', content: 'debate', timestamp: 1 }],
    });
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);

    const result = await reset.reset(handler as never, T);

    expect(result.segmentIndex).toBe(6);
    const rows = resetDb.listSnapshotsForThread(T);
    expect(rows).toHaveLength(1);
    expect(rows[0].segmentIndex).toBe(6);

    artifactDb.close();
    resetDb.close();
  });

  it('synthesisInFlight guard: throws SynthesisInProgressError when synthesis is in progress', async () => {
    // handler.isSynthesisInFlight returns true — reset must be refused.
    const resetDb = new ResetSnapshotDB(':memory:');
    const artifactDb = new ArtifactDB(':memory:');
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const handler = makeHandler({ isSynthesisInFlight: true });
    const reset = new SessionReset(resetDb, artifactDb, facilitator as never);

    await expect(reset.reset(handler as never, T)).rejects.toBeInstanceOf(SynthesisInProgressError);
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
    expect(handler.sealCurrentSegment).not.toHaveBeenCalled();
    expect(handler.openNewSegment).not.toHaveBeenCalled();
    expect(resetDb.listSnapshotsForThread(T)).toHaveLength(0);

    artifactDb.close();
    resetDb.close();
  });
});
