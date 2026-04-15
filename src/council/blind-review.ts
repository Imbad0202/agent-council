// src/council/blind-review.ts
/**
 * Blind review mode — Rawlsian-veil deliberation.
 *
 * Agents are referred to by anonymous codes (Agent-A, Agent-B, ...) until
 * the user has scored each one. The reveal message then maps codes to
 * real agent names + roles, alongside the user's scores.
 */

import { InlineKeyboard } from 'grammy';

export interface BlindReviewSession {
  threadId: number;
  startedAt: number;
  codeToAgentId: Map<string, string>;
  agentIdToRole: Map<string, string>;
  scores: Map<string, number>;
  revealed: boolean;
}

export type CreateResult = BlindReviewSession | { error: string };
export type RecordScoreResult = { allScored: boolean } | { error: string };

const CODE_PREFIX = 'Agent-';

export function assignCodes(agentIds: string[]): Map<string, string> {
  const sorted = [...agentIds].sort();
  const result = new Map<string, string>();
  sorted.forEach((agentId, idx) => {
    result.set(`${CODE_PREFIX}${String.fromCharCode(65 + idx)}`, agentId);
  });
  return result;
}

export class BlindReviewStore {
  private sessions = new Map<number, BlindReviewSession>();

  create(
    threadId: number,
    agentIds: string[],
    roles: Map<string, string>,
  ): CreateResult {
    const existing = this.sessions.get(threadId);
    if (existing && !existing.revealed) {
      return { error: 'pending blind-review session exists for this thread' };
    }
    const codeToAgentId = assignCodes(agentIds);
    const session: BlindReviewSession = {
      threadId,
      startedAt: Date.now(),
      codeToAgentId,
      agentIdToRole: new Map(roles),
      scores: new Map(),
      revealed: false,
    };
    this.sessions.set(threadId, session);
    return session;
  }

  get(threadId: number): BlindReviewSession | undefined {
    return this.sessions.get(threadId);
  }

  recordScore(threadId: number, code: string, score: number): RecordScoreResult {
    const session = this.sessions.get(threadId);
    if (!session) return { error: 'no session for thread' };
    if (session.revealed) return { error: 'session already revealed' };
    if (!session.codeToAgentId.has(code)) return { error: `unknown code ${code}` };
    session.scores.set(code, score);
    const allScored = session.scores.size === session.codeToAgentId.size;
    return { allScored };
  }

  markRevealed(threadId: number): void {
    const session = this.sessions.get(threadId);
    if (session) session.revealed = true;
  }

  delete(threadId: number): void {
    this.sessions.delete(threadId);
  }
}

export function buildScoringKeyboard(codes: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  codes.forEach((code, i) => {
    if (i > 0) kb.row();
    for (let n = 1; n <= 5; n++) {
      kb.text(`${n}★`, `br-score:${code}:${n}`);
    }
  });
  return kb;
}

export function formatRevealMessage(
  session: BlindReviewSession,
  agentMeta: Map<string, { name: string; role: string }>,
): string {
  const lines: string[] = ['🎭 Blind Review Reveal', ''];
  for (const [code, agentId] of session.codeToAgentId.entries()) {
    const meta = agentMeta.get(agentId) ?? { name: agentId, role: session.agentIdToRole.get(agentId) ?? 'unknown' };
    const score = session.scores.get(code);
    const scoreStr = score !== undefined ? `your score: ${score}★` : 'not scored';
    lines.push(`${code} → ${meta.name} (role: ${meta.role}) — ${scoreStr}`);
  }
  lines.push('');
  lines.push('(Identities revealed; scores recorded for this round.)');
  return lines.join('\n');
}
