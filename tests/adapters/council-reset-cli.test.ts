import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCommandHandler } from '../../src/adapters/cli-commands.js';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import { MemoryDB } from '../../src/memory/db.js';
import { ResetSnapshotDB } from '../../src/storage/reset-snapshot-db.js';
import { ArtifactDB } from '../../src/council/artifact-db.js';
import { SessionReset } from '../../src/council/session-reset.js';
import { ResetCancelledError } from '../../src/council/session-reset-errors.js';

const THREAD = 7;

function makeDelibHandler(overrides: Partial<{
  blindReviewSessionId: string | null;
  resetInFlight: boolean;
  deliberationInFlight: boolean;
  pendingClassifications: boolean;
}> = {}) {
  return {
    getBlindReviewSessionId: vi.fn(() => overrides.blindReviewSessionId ?? null),
    getCurrentTopic: vi.fn(() => 'topic'),
    // Non-empty so the round-10 empty-segment guard doesn't short-circuit;
    // individual tests that care about segment contents override the mock.
    // Sentinel content is greppable for future maintainers.
    getCurrentSegmentMessages: vi.fn(() => [{ id: 'x', role: 'human', content: 'TEST_DEFAULT_TURN_ROUND10_GUARD', timestamp: 1 }] as readonly unknown[]),
    getSegments: vi.fn(() => [{ snapshotId: null }]),
    isResetInFlight: vi.fn(() => overrides.resetInFlight ?? false),
    isDeliberationInFlight: vi.fn(() => overrides.deliberationInFlight ?? false),
    hasPendingClassifications: vi.fn(() => overrides.pendingClassifications ?? false),
    isSynthesisInFlight: vi.fn(() => false),
    setResetInFlight: vi.fn(),
    sealCurrentSegment: vi.fn(),
    openNewSegment: vi.fn(),
    unsealCurrentSegment: vi.fn(),
    getCurrentResetController: vi.fn(() => null),
    setCurrentResetController: vi.fn(),
  };
}

function makeFacilitator(content: string) {
  return {
    respondDeterministic: vi.fn(async () => ({
      content,
      tokensUsed: { input: 1, output: 1 },
    })),
  };
}

const VALID_SUMMARY = [
  '## Decisions',
  '- x',
  '- y',
  '',
  '## Open Questions',
  '- q1',
  '',
  '## Evidence Pointers',
  '- e',
  '',
  '## Blind-Review State',
  'none',
  '',
].join('\n');

let tmpDir: string;
let sessions: CliSessionManager;
let memDb: MemoryDB;
let resetDb: ResetSnapshotDB;
let artifactDb: ArtifactDB;
let output: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-councilreset-test-'));
  sessions = new CliSessionManager(tmpDir);
  memDb = new MemoryDB(':memory:');
  resetDb = new ResetSnapshotDB(':memory:');
  artifactDb = new ArtifactDB(':memory:');
  output = [];
});

afterEach(() => {
  memDb.close();
  resetDb.close();
  artifactDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('/councilreset CLI', () => {
  it('prints one-line confirmation with segment index + counts on success', async () => {
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const sessionReset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const delib = makeDelibHandler();
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilreset', '');

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^Sealed segment 0: 2 decision\(s\), 1 open question\(s\)\./);
    expect(delib.sealCurrentSegment).toHaveBeenCalledWith(THREAD, expect.any(String));
    expect(delib.openNewSegment).toHaveBeenCalledWith(THREAD);
  });

  it('prints BlindReviewActiveError message when blind-review pending', async () => {
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const sessionReset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const delib = makeDelibHandler({ blindReviewSessionId: 'br-active' });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilreset', '');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('/blindreview reveal');
    expect(output[0]).toContain('/cancelreview');
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
  });

  it('prints ResetInProgressError message when another reset is mid-flight', async () => {
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const sessionReset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const delib = makeDelibHandler({ resetInFlight: true });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilreset', '');

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/in progress/i);
    expect(facilitator.respondDeterministic).not.toHaveBeenCalled();
  });

  it('says "not wired" if sessionReset is not provided', async () => {
    const handler = new CliCommandHandler(sessions, memDb, (line) => output.push(line));

    await handler.handleAsync('councilreset', '');

    expect(output[0]).toMatch(/not (available|wired|configured)/i);
  });
});

describe('/councilhistory CLI', () => {
  it('says "no resets yet" when empty', async () => {
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      { resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilhistory', '');

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/no resets yet/i);
  });

  it('lists all snapshots for the thread', async () => {
    resetDb.recordSnapshot({
      snapshotId: 'snap-0',
      threadId: THREAD,
      segmentIndex: 0,
      sealedAt: '2026-04-23T09:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 2, openQuestionsCount: 1, blindReviewSessionId: null },
    });
    resetDb.recordSnapshot({
      snapshotId: 'snap-1',
      threadId: THREAD,
      segmentIndex: 1,
      sealedAt: '2026-04-23T10:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 1, openQuestionsCount: 0, blindReviewSessionId: null },
    });

    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      { resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilhistory', '');

    expect(output).toHaveLength(2);
    expect(output[0]).toContain('[0]');
    expect(output[0]).toContain('2 decisions');
    expect(output[0]).toContain('1 open');
    expect(output[1]).toContain('[1]');
    expect(output[1]).toContain('1 decisions');
  });

  it('says "not wired" if resetSnapshotDB is not provided', async () => {
    const handler = new CliCommandHandler(sessions, memDb, (line) => output.push(line));

    await handler.handleAsync('councilhistory', '');

    expect(output[0]).toMatch(/not (available|wired|configured)/i);
  });

  // Round-16 codex finding [P2-CLI]: round-15 fixed the Telegram path so
  // /councilhistory works in facilitator-less deployments (DB-only
  // dependency), but src/index.ts kept passing `{}` to CliCommandHandler
  // when sessionReset was undefined — so CLI users in the same
  // deployment lost /councilhistory for no functional reason. The
  // CliCommandHandler contract is asserted here: given DB + threadId
  // but no sessionReset/deliberationHandler, /councilhistory must
  // function fully and /councilreset must reply "not configured".
  it('serves /councilhistory and replies not-configured for /councilreset with DB-only wiring', async () => {
    resetDb.recordSnapshot({
      snapshotId: 'snap-db-only',
      threadId: THREAD,
      segmentIndex: 0,
      sealedAt: '2026-04-23T09:00:00Z',
      summaryMarkdown: VALID_SUMMARY,
      metadata: { decisionsCount: 1, openQuestionsCount: 0, blindReviewSessionId: null },
    });

    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      // DB-only wiring: facilitator-less deployment shape.
      { resetSnapshotDB: resetDb, threadId: THREAD },
    );

    await handler.handleAsync('councilhistory', '');
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('[0]');
    expect(output[0]).toContain('1 decisions');

    output.length = 0;
    await handler.handleAsync('councilreset', '');
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/not configured/i);
  });
});

describe('/councilcancel CLI handler (v0.5.4 §7.6a)', () => {
  it('handleAsync(councilcancel) routes to councilCancel()', async () => {
    const facilitator = makeFacilitator(VALID_SUMMARY);
    const sessionReset = new SessionReset(resetDb, artifactDb, facilitator as never);
    const delib = makeDelibHandler();
    const handler = new CliCommandHandler(
      sessions, memDb, (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );
    const cancelSpy = vi.spyOn(handler as never, 'councilCancel');
    await handler.handleAsync('councilcancel', '');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('councilCancel with active reset → aborts controller, prints "Reset cancelled."', async () => {
    const ctrl = new AbortController();
    const sessionReset = new SessionReset(resetDb, artifactDb, makeFacilitator(VALID_SUMMARY) as never);
    const delib = {
      ...makeDelibHandler(),
      getCurrentResetController: vi.fn(() => ctrl),
    };
    const handler = new CliCommandHandler(
      sessions, memDb, (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );
    await handler.handleAsync('councilcancel', '');
    expect(ctrl.signal.aborted).toBe(true);
    expect(output).toContain('Reset cancelled.');
  });

  it('councilCancel with no reset in progress → prints "No reset in progress."', async () => {
    const sessionReset = new SessionReset(resetDb, artifactDb, makeFacilitator(VALID_SUMMARY) as never);
    const delib = {
      ...makeDelibHandler(),
      getCurrentResetController: vi.fn(() => null),
    };
    const handler = new CliCommandHandler(
      sessions, memDb, (line) => output.push(line),
      { sessionReset, deliberationHandler: delib as never, resetSnapshotDB: resetDb, threadId: THREAD },
    );
    await handler.handleAsync('councilcancel', '');
    expect(output).toContain('No reset in progress.');
  });

  it('councilCancel with DB-only-without-facilitator wiring → prints "not configured" message', async () => {
    // No sessionReset, no deliberationHandler — DB-only deployment
    const handler = new CliCommandHandler(
      sessions, memDb, (line) => output.push(line),
      { resetSnapshotDB: resetDb, threadId: THREAD },
    );
    await handler.handleAsync('councilcancel', '');
    expect(output).toContain('/councilcancel is not configured in this CLI session.');
  });
});
