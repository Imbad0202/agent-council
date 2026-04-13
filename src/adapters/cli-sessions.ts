import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CouncilMessage } from '../types.js';

export interface SavedSession {
  topic: string;
  outcome: string;
  confidence: number;
  savedAt: string;
  history: CouncilMessage[];
}

export interface SessionSummary {
  topic: string;
  outcome: string;
  confidence: number;
  savedAt: string;
  messageCount: number;
}

export class CliSessionManager {
  private sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  save(topic: string, outcome: string, confidence: number, history: CouncilMessage[]): void {
    const date = new Date().toISOString().slice(0, 10);
    const filename = `cli-${topic}-${date}.json`;
    const session: SavedSession = { topic, outcome, confidence, savedAt: new Date().toISOString(), history };
    writeFileSync(join(this.sessionsDir, filename), JSON.stringify(session, null, 2), 'utf-8');
  }

  list(): SessionSummary[] {
    const files = this.getSessionFiles();
    return files.map((f) => {
      const session = JSON.parse(readFileSync(join(this.sessionsDir, f), 'utf-8')) as SavedSession;
      return {
        topic: session.topic,
        outcome: session.outcome,
        confidence: session.confidence,
        savedAt: session.savedAt,
        messageCount: session.history.length,
      };
    });
  }

  load(index: number): SavedSession | null {
    const files = this.getSessionFiles();
    if (index < 0 || index >= files.length) return null;
    return JSON.parse(readFileSync(join(this.sessionsDir, files[index]), 'utf-8')) as SavedSession;
  }

  delete(index: number): boolean {
    const files = this.getSessionFiles();
    if (index < 0 || index >= files.length) return false;
    unlinkSync(join(this.sessionsDir, files[index]));
    return true;
  }

  private getSessionFiles(): string[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.json'))
      .sort()
      .reverse();
  }
}
