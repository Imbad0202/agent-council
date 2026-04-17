// src/council/blind-review.ts
/**
 * Blind review mode — Rawlsian-veil deliberation.
 *
 * Agents are referred to by anonymous codes (Agent-A, Agent-B, ...) until
 * the user has scored each one. The reveal message then maps codes to
 * real agent names + roles, alongside the user's scores.
 */

import { InlineKeyboard } from 'grammy';
import type { AgentTier } from '../types.js';

export interface TurnRecord {
  agentId: string;
  tier: AgentTier;
  model: string;
}

export interface BlindReviewSession {
  threadId: number;
  startedAt: number;
  codeToAgentId: Map<string, string>;
  agentIdToRole: Map<string, string>;
  scores: Map<string, number>;
  feedbackText: Map<string, string>;
  turnLog: TurnRecord[];
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

/**
 * In-memory store of blind-review sessions, keyed by threadId.
 *
 * Lifecycle:
 *   1. create() — start a new session (rejects if pending one exists)
 *   2. recordScore() — accumulate user scores (per code)
 *   3. markRevealed() — flag the session as complete after reveal broadcast
 *
 * Revealed sessions are KEPT in the store, not deleted, so a stale
 * /cancelreview after reveal is a no-op rather than a confusing error.
 * They occupy ~200 bytes each and are bounded by chat lifetime; bot
 * restart clears the store. Explicit deletion happens only via
 * /cancelreview on a still-pending session.
 */
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
      feedbackText: new Map(),
      turnLog: [],
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

  recordTurn(threadId: number, agentId: string, tier: AgentTier, model: string): void {
    const session = this.sessions.get(threadId);
    if (!session || session.revealed) return;
    session.turnLog.push({ agentId, tier, model });
  }

  getLatestTurnFor(threadId: number, agentId: string): { tier: AgentTier; model: string } | null {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    const record = [...session.turnLog].reverse().find((t) => t.agentId === agentId);
    return record ? { tier: record.tier, model: record.model } : null;
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
    const name = agentMeta.get(agentId)?.name ?? agentId;
    const role = session.agentIdToRole.get(agentId) ?? agentMeta.get(agentId)?.role ?? 'unknown';
    const score = session.scores.get(code);
    const scoreStr = score !== undefined ? `your score: ${score}★` : 'not scored';
    lines.push(`${code} → ${name} (role: ${role}) — ${scoreStr}`);
  }
  lines.push('');
  lines.push('(Identities revealed; scores recorded for this round.)');
  return lines.join('\n');
}
