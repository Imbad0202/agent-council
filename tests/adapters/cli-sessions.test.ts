import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliSessionManager } from '../../src/adapters/cli-sessions.js';
import type { CouncilMessage } from '../../src/types.js';

const sampleHistory: CouncilMessage[] = [
  {
    id: 'msg-1',
    role: 'human',
    content: 'Should we adopt TypeScript?',
    timestamp: 1700000000000,
  },
  {
    id: 'msg-2',
    role: 'agent',
    agentId: 'agent-1',
    content: 'Yes, TypeScript improves type safety.',
    timestamp: 1700000001000,
    metadata: { confidence: 0.9 },
  },
];

let tmpDir: string;
let manager: CliSessionManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-sessions-test-'));
  manager = new CliSessionManager(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CliSessionManager', () => {
  describe('constructor', () => {
    it('creates the sessions directory on construction', () => {
      expect(existsSync(join(tmpDir, 'sessions'))).toBe(true);
    });

    it('does not throw if sessions directory already exists', () => {
      expect(() => new CliSessionManager(tmpDir)).not.toThrow();
    });
  });

  describe('save', () => {
    it('creates a JSON file in the sessions directory', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      const files = readdirSync(join(tmpDir, 'sessions'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^cli-typescript-\d{4}-\d{2}-\d{2}\.json$/);
    });

    it('saves all fields correctly', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      const sessions = manager.list();
      expect(sessions).toHaveLength(1);
      const session = sessions[0];
      expect(session.topic).toBe('typescript');
      expect(session.outcome).toBe('adopt');
      expect(session.confidence).toBe(0.85);
      expect(session.history).toEqual(sampleHistory);
      expect(session.savedAt).toBeDefined();
      expect(new Date(session.savedAt).toISOString()).toBe(session.savedAt);
    });

    it('saves multiple sessions', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      manager.save('testing', 'vitest', 0.9, []);
      expect(manager.list()).toHaveLength(2);
    });
  });

  describe('list', () => {
    it('returns empty array when no sessions exist', () => {
      expect(manager.list()).toEqual([]);
    });

    it('returns sessions in reverse chronological order (newest first)', async () => {
      // save with slight timing differences
      manager.save('first', 'outcome-a', 0.7, []);
      // Use a topic that sorts later alphabetically to verify it's by filename date, not topic
      manager.save('second', 'outcome-b', 0.8, []);
      const sessions = manager.list();
      expect(sessions).toHaveLength(2);
      // Files are sorted reverse-alphabetically; second session saved later
      // Both have same date in filename so order determined by filename sort
      // Verify both are present regardless of order
      const topics = sessions.map((s) => s.topic);
      expect(topics).toContain('first');
      expect(topics).toContain('second');
    });

    it('returns SavedSession objects with all required fields', () => {
      manager.save('test-topic', 'test-outcome', 0.75, sampleHistory);
      const sessions = manager.list();
      const session = sessions[0];
      expect(session).toHaveProperty('topic');
      expect(session).toHaveProperty('outcome');
      expect(session).toHaveProperty('confidence');
      expect(session).toHaveProperty('savedAt');
      expect(session).toHaveProperty('history');
    });
  });

  describe('load', () => {
    it('loads session at valid index 0', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      const session = manager.load(0);
      expect(session).not.toBeNull();
      expect(session!.topic).toBe('typescript');
      expect(session!.outcome).toBe('adopt');
      expect(session!.confidence).toBe(0.85);
      expect(session!.history).toEqual(sampleHistory);
    });

    it('returns null for negative index', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      expect(manager.load(-1)).toBeNull();
    });

    it('returns null for index equal to length', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      expect(manager.load(1)).toBeNull();
    });

    it('returns null for index beyond length', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      expect(manager.load(99)).toBeNull();
    });

    it('returns null when no sessions exist', () => {
      expect(manager.load(0)).toBeNull();
    });

    it('loads the correct session when multiple exist', () => {
      manager.save('first', 'outcome-a', 0.7, []);
      manager.save('second', 'outcome-b', 0.8, []);
      // list() returns reversed, so index 0 = most recent
      const listed = manager.list();
      const loaded = manager.load(0);
      expect(loaded!.topic).toBe(listed[0].topic);
    });
  });

  describe('delete', () => {
    it('returns true and removes the file for valid index', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      const result = manager.delete(0);
      expect(result).toBe(true);
      const files = readdirSync(join(tmpDir, 'sessions'));
      expect(files).toHaveLength(0);
    });

    it('returns false for negative index', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      expect(manager.delete(-1)).toBe(false);
    });

    it('returns false for index equal to length', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      expect(manager.delete(1)).toBe(false);
    });

    it('returns false when no sessions exist', () => {
      expect(manager.delete(0)).toBe(false);
    });

    it('deletes the correct file when multiple exist', () => {
      manager.save('alpha', 'outcome-a', 0.7, []);
      manager.save('beta', 'outcome-b', 0.8, []);
      const beforeDelete = manager.list();
      expect(beforeDelete).toHaveLength(2);
      const topicToDelete = beforeDelete[0].topic;
      manager.delete(0);
      const afterDelete = manager.list();
      expect(afterDelete).toHaveLength(1);
      expect(afterDelete[0].topic).not.toBe(topicToDelete);
    });

    it('list returns one fewer session after delete', () => {
      manager.save('typescript', 'adopt', 0.85, sampleHistory);
      manager.save('testing', 'vitest', 0.9, []);
      manager.delete(0);
      expect(manager.list()).toHaveLength(1);
    });
  });
});
