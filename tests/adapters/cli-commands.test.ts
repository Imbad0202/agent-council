import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCommandHandler } from '../../src/adapters/cli-commands.js';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import { MemoryDB } from '../../src/memory/db.js';
import type { MemoryRecord } from '../../src/types.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    agentId: 'agent-a',
    type: 'principle',
    topic: 'testing',
    confidence: 0.8,
    outcome: null,
    usageCount: 3,
    lastUsed: '2026-04-01',
    createdAt: '2026-03-01',
    contentPreview: 'Always write tests before implementation.',
    ...overrides,
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let sessions: CliSessionManager;
let db: MemoryDB;
let output: string[];
let handler: CliCommandHandler;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-commands-test-'));
  sessions = new CliSessionManager(tmpDir);
  db = new MemoryDB(':memory:');
  output = [];
  handler = new CliCommandHandler(sessions, db, (line) => output.push(line));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── /help ─────────────────────────────────────────────────────────────────────

describe('/help', () => {
  it('prints the Available commands header', () => {
    handler.handle('help', '');
    expect(output[0]).toBe('Available commands:');
  });

  it('lists all documented commands', () => {
    handler.handle('help', '');
    const joined = output.join('\n');
    expect(joined).toContain('/help');
    expect(joined).toContain('/debug');
    expect(joined).toContain('/quit');
    expect(joined).toContain('/sessions');
    expect(joined).toContain('/resume');
    expect(joined).toContain('/delete');
    expect(joined).toContain('/memories');
    expect(joined).toContain('/memory');
    expect(joined).toContain('/forget');
    expect(joined).toContain('/patterns');
  });
});

// ── /sessions ────────────────────────────────────────────────────────────────

describe('/sessions', () => {
  it('prints "No saved sessions." when empty', () => {
    handler.handle('sessions', '');
    expect(output).toEqual(['No saved sessions.']);
  });

  it('lists sessions with index, topic, date, outcome, confidence', () => {
    sessions.save('typescript', 'adopt', 0.85, []);
    output = [];
    handler.handle('sessions', '');
    expect(output[0]).toBe('Saved sessions:');
    expect(output[1]).toMatch(/1\. typescript/);
    expect(output[1]).toMatch(/adopt/);
    expect(output[1]).toMatch(/0\.85/);
  });

  it('lists multiple sessions with correct indices', () => {
    sessions.save('alpha', 'accept', 0.7, []);
    sessions.save('beta', 'reject', 0.6, []);
    output = [];
    handler.handle('sessions', '');
    expect(output).toHaveLength(3); // header + 2 sessions
    expect(output[1]).toMatch(/^  1\./);
    expect(output[2]).toMatch(/^  2\./);
  });
});

// ── /delete ───────────────────────────────────────────────────────────────────

describe('/delete', () => {
  it('deletes a valid session by 1-based index', () => {
    sessions.save('typescript', 'adopt', 0.85, []);
    output = [];
    handler.handle('delete', '1');
    expect(output).toEqual(['Deleted.']);
    expect(sessions.list()).toHaveLength(0);
  });

  it('prints error for non-numeric arg', () => {
    sessions.save('typescript', 'adopt', 0.85, []);
    output = [];
    handler.handle('delete', 'abc');
    expect(output[0]).toMatch(/Invalid index/);
  });

  it('prints error for arg "0"', () => {
    sessions.save('typescript', 'adopt', 0.85, []);
    output = [];
    handler.handle('delete', '0');
    expect(output[0]).toMatch(/Invalid index/);
  });

  it('prints "session not found" for out-of-range index', () => {
    sessions.save('typescript', 'adopt', 0.85, []);
    output = [];
    handler.handle('delete', '99');
    expect(output[0]).toMatch(/session not found/);
  });

  it('prints error for empty arg', () => {
    handler.handle('delete', '');
    expect(output[0]).toMatch(/Invalid index/);
  });
});

// ── /memories ─────────────────────────────────────────────────────────────────

describe('/memories', () => {
  it('prints "No active principles or rules." when DB is empty', () => {
    handler.handle('memories', '');
    expect(output).toEqual(['No active principles or rules.']);
  });

  it('lists a principle memory', () => {
    db.insertMemory(makeRecord({ id: 'mem-p', type: 'principle', contentPreview: 'Write tests first.' }));
    output = [];
    handler.handle('memories', '');
    expect(output[0]).toBe('Active memories:');
    const line = output.find((l) => l.includes('mem-p'));
    expect(line).toBeDefined();
    expect(line).toContain('[principle]');
    expect(line).toContain('Write tests first.');
  });

  it('lists a rule memory', () => {
    db.insertMemory(makeRecord({ id: 'mem-r', type: 'rule', contentPreview: 'Never skip tests.' }));
    output = [];
    handler.handle('memories', '');
    const line = output.find((l) => l.includes('mem-r'));
    expect(line).toBeDefined();
    expect(line).toContain('[rule]');
  });

  it('does not list session or archive memories', () => {
    db.insertMemory(makeRecord({ id: 'mem-s', type: 'session', contentPreview: 'Session memory.' }));
    db.insertMemory(makeRecord({ id: 'mem-a', type: 'archive', contentPreview: 'Archived memory.' }));
    output = [];
    handler.handle('memories', '');
    expect(output).toEqual(['No active principles or rules.']);
  });

  it('shows confidence in each line', () => {
    db.insertMemory(makeRecord({ id: 'mem-p', type: 'principle', confidence: 0.92 }));
    output = [];
    handler.handle('memories', '');
    const line = output.find((l) => l.includes('mem-p'));
    expect(line).toContain('0.92');
  });

  it('truncates contentPreview to 80 chars in the listing', () => {
    const longContent = 'A'.repeat(120);
    db.insertMemory(makeRecord({ id: 'mem-long', type: 'principle', contentPreview: longContent }));
    output = [];
    handler.handle('memories', '');
    const line = output.find((l) => l.includes('mem-long'))!;
    // The displayed portion of content should be at most 80 chars
    const afterDash = line.split(' — ')[1];
    const contentPart = afterDash.split(' (confidence')[0];
    expect(contentPart.length).toBeLessThanOrEqual(80);
  });
});

// ── /memory <id> ──────────────────────────────────────────────────────────────

describe('/memory', () => {
  it('shows error when no id given', () => {
    handler.handle('memory', '');
    expect(output).toEqual(['Usage: /memory <id>']);
  });

  it('shows "Memory not found" for unknown id', () => {
    handler.handle('memory', 'nonexistent');
    expect(output).toEqual(['Memory not found: nonexistent']);
  });

  it('shows full memory details for a known id', () => {
    db.insertMemory(makeRecord({ id: 'mem-detail', type: 'principle', topic: 'quality', confidence: 0.75, usageCount: 5 }));
    output = [];
    handler.handle('memory', 'mem-detail');
    const joined = output.join('\n');
    expect(joined).toContain('ID: mem-detail');
    expect(joined).toContain('Type: principle');
    expect(joined).toContain('Topic: quality');
    expect(joined).toContain('Confidence: 0.75');
    expect(joined).toContain('Usage: 5 times');
    expect(joined).toContain('Content:');
  });

  it('shows "none" for null topic', () => {
    db.insertMemory(makeRecord({ id: 'mem-notopic', topic: null }));
    output = [];
    handler.handle('memory', 'mem-notopic');
    expect(output.find((l) => l.startsWith('Topic:'))).toBe('Topic: none');
  });

  it('shows "none" for null outcome', () => {
    db.insertMemory(makeRecord({ id: 'mem-nooutcome', outcome: null }));
    output = [];
    handler.handle('memory', 'mem-nooutcome');
    expect(output.find((l) => l.startsWith('Outcome:'))).toBe('Outcome: none');
  });
});

// ── /forget ───────────────────────────────────────────────────────────────────

describe('/forget', () => {
  it('shows error when no id given', () => {
    handler.handle('forget', '');
    expect(output).toEqual(['Usage: /forget <id>']);
  });

  it('shows "Memory not found" for unknown id', () => {
    handler.handle('forget', 'ghost');
    expect(output).toEqual(['Memory not found: ghost']);
  });

  it('archives the memory and prints confirmation', () => {
    db.insertMemory(makeRecord({ id: 'mem-forget', type: 'principle' }));
    output = [];
    handler.handle('forget', 'mem-forget');
    expect(output).toEqual(['Archived: mem-forget']);
    const updated = db.getMemory('mem-forget');
    expect(updated?.type).toBe('archive');
  });
});

// ── /patterns ─────────────────────────────────────────────────────────────────

describe('/patterns', () => {
  it('prints "No behavioral patterns recorded." when none exist', () => {
    handler.handle('patterns', '');
    expect(output).toEqual(['No behavioral patterns recorded.']);
  });
});

// ── unknown command ───────────────────────────────────────────────────────────

describe('unknown command', () => {
  it('prints helpful error for an unrecognized command', () => {
    handler.handle('foobar', '');
    expect(output).toEqual(['Unknown command: /foobar. Type /help for available commands.']);
  });

  it('handles empty string command gracefully', () => {
    handler.handle('', '');
    expect(output[0]).toContain('Unknown command');
  });
});
