import type { AdversarialRole, AdversarialDebriefRecord } from './adversarial-provers.js';

export interface PvgRotateSession {
  threadId: number;
  plantedRole: AdversarialRole;
  startedAt: number;
  guessedRole?: AdversarialRole;
  guessedAt?: number;
  plantedDebrief?: AdversarialDebriefRecord;
}

export type CreateResult = PvgRotateSession | { error: string };
export type RecordGuessResult =
  | { correct: boolean; plantedRole: AdversarialRole }
  | { error: string };

export class PvgRotateStore {
  private sessions = new Map<number, PvgRotateSession>();

  create(threadId: number, plantedRole: AdversarialRole): CreateResult {
    const existing = this.sessions.get(threadId);
    if (existing && existing.guessedRole === undefined) {
      return { error: 'pending pvg-rotate session exists for this thread' };
    }
    const session: PvgRotateSession = {
      threadId,
      plantedRole,
      startedAt: Date.now(),
    };
    this.sessions.set(threadId, session);
    return session;
  }

  get(threadId: number): PvgRotateSession | undefined {
    return this.sessions.get(threadId);
  }

  attachDebrief(threadId: number, debrief: AdversarialDebriefRecord): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.plantedDebrief = debrief;
  }

  recordGuess(threadId: number, guessedRole: AdversarialRole): RecordGuessResult {
    const session = this.sessions.get(threadId);
    if (!session) return { error: 'no pvg-rotate session for thread' };
    if (session.guessedRole !== undefined) {
      return { error: 'guess already recorded for this round' };
    }
    session.guessedRole = guessedRole;
    session.guessedAt = Date.now();
    return {
      correct: guessedRole === session.plantedRole,
      plantedRole: session.plantedRole,
    };
  }

  delete(threadId: number): void {
    this.sessions.delete(threadId);
  }
}
