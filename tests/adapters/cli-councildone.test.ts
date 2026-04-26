import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCommandHandler, CLI_COMMAND_NAMES } from '../../src/adapters/cli-commands.js';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import { MemoryDB } from '../../src/memory/db.js';
import type { ArtifactService } from '../../src/council/artifact-service.js';
import type { ArtifactRow } from '../../src/council/artifact-db.js';

const THREAD = 42;

function makeArtifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 1,
    thread_id: THREAD,
    segment_index: 0,
    thread_local_seq: 1,
    preset: 'universal',
    content_md: [
      '## TL;DR',
      '',
      'A concise conclusion from the council deliberation.',
      '',
      '## Discussion',
      '',
      'Key discussion points here.',
      '',
    ].join('\n'),
    created_at: '2026-04-26T00:00:00Z',
    synthesis_model: 'claude-sonnet-4-6',
    synthesis_token_usage_json: '{}',
    ...overrides,
  };
}

function makeArtifactService(overrides: Partial<{
  synthesize: ArtifactService['synthesize'];
  fetchByThreadLocalSeq: ArtifactService['fetchByThreadLocalSeq'];
}> = {}): ArtifactService {
  return {
    synthesize: overrides.synthesize ?? vi.fn(async () => makeArtifactRow()),
    fetchByThreadLocalSeq: overrides.fetchByThreadLocalSeq ?? vi.fn(() => null),
    lastSealedSegmentIndex: vi.fn(() => null),
  } as unknown as ArtifactService;
}

let tmpDir: string;
let sessions: CliSessionManager;
let memDb: MemoryDB;
let output: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-councildone-test-'));
  sessions = new CliSessionManager(tmpDir);
  memDb = new MemoryDB(':memory:');
  output = [];
});

afterEach(() => {
  memDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: Whitelist contains both commands ──────────────────────────────────

describe('CLI_COMMAND_NAMES whitelist', () => {
  it('contains councildone', () => {
    expect(CLI_COMMAND_NAMES.has('councildone')).toBe(true);
  });

  it('contains councilshow', () => {
    expect(CLI_COMMAND_NAMES.has('councilshow')).toBe(true);
  });
});

// ── Tests 2-4: /councildone preset handling ───────────────────────────────────

describe('/councildone CLI', () => {
  it('rejects unknown preset with descriptive error', async () => {
    const svc = makeArtifactService();
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', 'foobar');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('unknown preset');
    expect(output[0]).toContain('universal');
    expect(output[0]).toContain('decision');
    expect((svc.synthesize as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  // Spec §6: extra args after a valid preset must be rejected — the parser
  // does not split-and-take-first; the entire trimmed arg string must equal
  // 'universal' or 'decision' (or be empty). `decision foo` is NOT a valid
  // invocation — it must surface the same "unknown preset" error.
  it('rejects "decision foo" (extra args after valid preset per spec §6)', async () => {
    const svc = makeArtifactService();
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', 'decision foo');

    expect(output.some(line => line.includes('unknown preset'))).toBe(true);
    expect((svc.synthesize as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  // Spec §6: preset matching is case-sensitive — `Decision`, `UNIVERSAL`,
  // `Universal` must all reject. Strict equality (`trimmed === 'decision'`)
  // is the contract; any case-insensitive normalization would silently
  // expand the accepted surface and drift from the spec.
  it('rejects "Decision" (case-sensitive per spec §6)', async () => {
    const svc = makeArtifactService();
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', 'Decision');

    expect(output.some(line => line.includes('unknown preset'))).toBe(true);
    expect((svc.synthesize as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('uses universal preset when arg is empty', async () => {
    const synthesize = vi.fn(async () => makeArtifactRow({ preset: 'universal', thread_local_seq: 1 }));
    const svc = makeArtifactService({ synthesize });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', '');

    expect(synthesize).toHaveBeenCalledWith(THREAD, 'universal');
  });

  it('uses decision preset when arg is "decision"', async () => {
    const synthesize = vi.fn(async () => makeArtifactRow({ preset: 'decision', thread_local_seq: 2 }));
    const svc = makeArtifactService({ synthesize });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', 'decision');

    expect(synthesize).toHaveBeenCalledWith(THREAD, 'decision');
  });

  it('prints success lines including artifact seq and preset', async () => {
    const svc = makeArtifactService({
      synthesize: vi.fn(async () => makeArtifactRow({ preset: 'universal', thread_local_seq: 3 })),
    });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councildone', '');

    // Should print 3 lines: artifact confirmation, TL;DR preview, councilshow hint
    expect(output.length).toBeGreaterThanOrEqual(3);
    expect(output[0]).toContain('Artifact #3');
    expect(output[0]).toContain('universal');
    expect(output[1]).toContain('TL;DR');
    expect(output[2]).toContain('/councilshow 3');
  });

  it('reports "not configured" when artifactService is not wired', async () => {
    const handler = new CliCommandHandler(sessions, memDb, (line) => output.push(line));

    await handler.handleAsync('councildone', '');

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/not configured/i);
  });
});

// ── Tests 5-6: /councilshow ───────────────────────────────────────────────────

describe('/councilshow CLI', () => {
  it('fetches artifact by thread_local_seq and prints content_md', async () => {
    const row = makeArtifactRow({ thread_local_seq: 5 });
    const fetchByThreadLocalSeq = vi.fn(() => row);
    const svc = makeArtifactService({ fetchByThreadLocalSeq });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councilshow', '5');

    expect(fetchByThreadLocalSeq).toHaveBeenCalledWith(THREAD, 5);
    expect(output.join('\n')).toContain(row.content_md);
  });

  it.each(['0', '-1', '3.5', '', 'abc', '999999999999'])(
    'rejects invalid id "%s"',
    async (badId) => {
      const svc = makeArtifactService();
      const handler = new CliCommandHandler(
        sessions,
        memDb,
        (line) => output.push(line),
        {},
        { artifactService: svc, threadId: THREAD },
      );

      output.length = 0;
      await handler.handleAsync('councilshow', badId);

      // Should print usage hint, not call fetch
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('/councilshow');
      expect((svc.fetchByThreadLocalSeq as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    },
  );

  it('prints "not found" when artifact does not exist', async () => {
    const svc = makeArtifactService({ fetchByThreadLocalSeq: vi.fn(() => null) });
    const handler = new CliCommandHandler(
      sessions,
      memDb,
      (line) => output.push(line),
      {},
      { artifactService: svc, threadId: THREAD },
    );

    await handler.handleAsync('councilshow', '99');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('99');
    expect(output[0]).toMatch(/not found/i);
  });

  it('reports "not configured" when artifactService is not wired', async () => {
    const handler = new CliCommandHandler(sessions, memDb, (line) => output.push(line));

    await handler.handleAsync('councilshow', '1');

    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/not configured/i);
  });
});
