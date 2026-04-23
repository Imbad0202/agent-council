import type { EventBus } from '../events/bus.js';
import type { AgentWorker } from '../worker/agent-worker.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type {
  CouncilConfig,
  CouncilMessage,
  AgentRole,
  Complexity,
  IntentType,
  ResponseClassification,
  ProviderResponse,
  HistorySegment,
} from '../types.js';
import { TurnManager } from '../gateway/turn-manager.js';
import { AntiSycophancyEngine } from './anti-sycophancy.js';
import { assignRoles } from './role-assigner.js';
import { PATTERN_INJECTION_PROMPTS } from './pattern-prompts.js';
import { pickSneakyTarget } from './sneaky-prover.js';
import {
  processAdversarialResponse,
  formatAdversarialDebrief,
  ADVERSARIAL_MODE_TO_ROLE,
  type AdversarialDebriefRecord,
} from './adversarial-provers.js';
import { BlindReviewStore, buildScoringKeyboard } from './blind-review.js';
import { pickRandomAdversarialRole, buildRotationKeyboard } from './pvg-rotate.js';
import { PvgRotateStore } from './pvg-rotate-store.js';
import type { AdversarialRole } from './adversarial-provers.js';
import type { HumanCritiqueStore, CritiqueOutcome } from './human-critique-store.js';
import { makeHumanCritique, type HumanCritiqueStance } from './human-critique.js';
import { buildCritiquePrompt } from './human-critique-prompts.js';
import { scoreSession, type DepthScoreResult } from './collaboration-depth.js';

const DEFAULT_CRITIQUE_TIMEOUT_MS = 30_000;
const HUMAN_SENTINEL = '__human__';

interface CritiqueRecordInternal {
  stance: HumanCritiqueStance;
  acknowledgedByNextAgent: boolean;
  introducedNovelAngle: boolean;
}

export interface CritiqueSessionLog {
  agentTurns: number;
  humanCritiques: CritiqueRecordInternal[];
  stanceShiftsInducedByHuman: number;
}

type SendFn = (agentId: string, content: string, threadId?: number) => Promise<void>;
type SendKeyboardFn = (agentId: string, content: string, keyboard: import('grammy').InlineKeyboard, threadId?: number) => Promise<void>;

interface SessionState {
  segments: HistorySegment[];
  currentParticipants: string[];
  turnManager: TurnManager;
  antiSycophancy: AntiSycophancyEngine;
  pendingPatternInjection: { targetAgent: string; prompt: string } | null;
  critiqueLog: CritiqueSessionLog;
  blindReviewSessionId: string | null;
  currentTopic: string;
  resetInFlight: boolean;
  // True while runDeliberation is mid-flight for this thread. SessionReset
  // checks this before sealing so a reset can't snapshot one transcript and
  // seal a later one — see round-7 audit finding.
  deliberationInFlight: boolean;
}

export class DeliberationHandler {
  private bus: EventBus;
  private workers: AgentWorker[];
  private facilitatorWorker: AgentWorker | undefined;
  private config: CouncilConfig;
  private sendFn: SendFn;
  private sendKeyboardFn: SendKeyboardFn | undefined;
  private blindReviewStore = new BlindReviewStore();
  private pvgRotateStore: PvgRotateStore;
  private critiqueStore: HumanCritiqueStore | undefined;
  private critiqueTimeoutMs: number;
  private resetSnapshotDB: ResetSnapshotDB | undefined;
  private sessions: Map<number, SessionState> = new Map();

  public getBlindReviewStore(): BlindReviewStore {
    return this.blindReviewStore;
  }

  public getPvgRotateStore(): PvgRotateStore {
    return this.pvgRotateStore;
  }

  public getCritiqueSessionLog(threadId: number): CritiqueSessionLog | undefined {
    const session = this.sessions.get(threadId);
    if (!session) return undefined;
    // Return a shallow copy so callers can't mutate session state.
    return {
      agentTurns: session.critiqueLog.agentTurns,
      humanCritiques: session.critiqueLog.humanCritiques.map((c) => ({ ...c })),
      stanceShiftsInducedByHuman: session.critiqueLog.stanceShiftsInducedByHuman,
    };
  }

  constructor(
    bus: EventBus,
    workers: AgentWorker[],
    config: CouncilConfig,
    sendFn: SendFn,
    options?: {
      facilitatorWorker?: AgentWorker;
      sendKeyboardFn?: SendKeyboardFn;
      pvgRotateStore?: PvgRotateStore;
      critiqueStore?: HumanCritiqueStore;
      critiqueTimeoutMs?: number;
      resetSnapshotDB?: ResetSnapshotDB;
    },
  ) {
    this.bus = bus;
    this.workers = workers;
    this.facilitatorWorker = options?.facilitatorWorker;
    this.config = config;
    this.sendFn = sendFn;
    this.sendKeyboardFn = options?.sendKeyboardFn;
    this.pvgRotateStore = options?.pvgRotateStore ?? new PvgRotateStore();
    this.critiqueStore = options?.critiqueStore;
    this.critiqueTimeoutMs = options?.critiqueTimeoutMs ?? DEFAULT_CRITIQUE_TIMEOUT_MS;
    this.resetSnapshotDB = options?.resetSnapshotDB;

    // Subscribe to intent.classified — skip 'meta' intent
    this.bus.on('intent.classified', (payload) => {
      if (payload.intent === 'meta') return;
      this.runDeliberation(payload.threadId, payload.message, payload.intent, payload.complexity);
    });

    // Subscribe to facilitator.intervened — only add non-structure messages to history
    // Structure announcements (opening messages) are display-only, not part of deliberation context
    this.bus.on('facilitator.intervened', (payload) => {
      if (payload.action === 'structure') return;

      const session = this.sessions.get(payload.threadId);
      if (!session) return;

      const facilitatorMsg: CouncilMessage = {
        id: `facilitator-${Date.now()}`,
        role: 'agent',
        agentId: 'facilitator',
        content: payload.content,
        timestamp: Date.now(),
        threadId: payload.threadId,
        metadata: {
          assignedRole: 'synthesizer',
        },
      };
      this.currentMessages(session).push(facilitatorMsg);
    });

    // Subscribe to pattern.detected — store pending injection
    this.bus.on('pattern.detected', (payload) => {
      const session = this.sessions.get(payload.threadId);
      if (!session) return;

      session.pendingPatternInjection = {
        targetAgent: payload.targetAgent,
        prompt: PATTERN_INJECTION_PROMPTS[payload.pattern],
      };
    });

    // Track blind-review session id on per-thread SessionState so /councilreset
    // can refuse resets while a blind-review round is still unrevealed.
    this.bus.on('blind-review.started', ({ threadId, sessionId }) => {
      const session = this.sessions.get(threadId);
      if (!session) return;
      session.blindReviewSessionId = sessionId;
    });

    this.bus.on('blind-review.revealed', ({ threadId }) => {
      const session = this.sessions.get(threadId);
      if (!session) return;
      session.blindReviewSessionId = null;
    });

    // Round-8 codex finding [P2]: `/cancelreview` has to clear the guard
    // too, otherwise /councilreset stays blocked on the thread forever.
    // Mirrors the `revealed` listener exactly.
    this.bus.on('blind-review.cancelled', ({ threadId }) => {
      const session = this.sessions.get(threadId);
      if (!session) return;
      session.blindReviewSessionId = null;
    });
  }

  private getSession(threadId: number): SessionState {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, {
        segments: [
          { startedAt: new Date().toISOString(), endedAt: null, messages: [], snapshotId: null },
        ],
        currentParticipants: this.workers.map((w) => w.id),
        turnManager: new TurnManager(this.config.gateway),
        antiSycophancy: new AntiSycophancyEngine(this.config.antiSycophancy),
        pendingPatternInjection: null,
        critiqueLog: { agentTurns: 0, humanCritiques: [], stanceShiftsInducedByHuman: 0 },
        blindReviewSessionId: null,
        currentTopic: '',
        resetInFlight: false,
        deliberationInFlight: false,
      });
    }
    return this.sessions.get(threadId)!;
  }

  // Internal write path. External readers use getCurrentSegmentMessages which
  // returns the readonly view declared on HistorySegment. The cast is the
  // single mutation boundary — keep it here.
  private currentMessages(session: SessionState): CouncilMessage[] {
    return session.segments[session.segments.length - 1].messages as CouncilMessage[];
  }

  public getSegments(threadId: number): readonly Readonly<HistorySegment>[] {
    return this.getSession(threadId).segments;
  }

  public getCurrentSegmentMessages(threadId: number): readonly CouncilMessage[] {
    const segs = this.getSession(threadId).segments;
    return segs[segs.length - 1].messages;
  }

  public sealCurrentSegment(threadId: number, snapshotId: string): void {
    const session = this.getSession(threadId);
    const last = session.segments[session.segments.length - 1];
    if (last.endedAt !== null) {
      throw new Error(`segment ${session.segments.length - 1} already sealed`);
    }
    last.endedAt = new Date().toISOString();
    last.snapshotId = snapshotId;
  }

  public openNewSegment(threadId: number): void {
    const session = this.getSession(threadId);
    const last = session.segments[session.segments.length - 1];
    if (last.endedAt === null) {
      throw new Error('must seal current segment before opening a new one');
    }
    session.segments.push({
      startedAt: new Date().toISOString(),
      endedAt: null,
      messages: [],
      snapshotId: null,
    });
  }

  // Undoes the last sealCurrentSegment on this thread. Used by SessionReset
  // when openNewSegment fails post-seal so the thread doesn't get stuck
  // writing into a sealed segment.
  public unsealCurrentSegment(threadId: number): void {
    const session = this.getSession(threadId);
    const last = session.segments[session.segments.length - 1];
    if (last.endedAt === null) {
      throw new Error('cannot unseal: current segment is not sealed');
    }
    last.endedAt = null;
    last.snapshotId = null;
  }

  // Returns the most recent reset-snapshot summary for this thread, or null
  // if no prior /councilreset has happened (or resetSnapshotDB is not wired).
  // Live segment state is the source of truth for which snapshot is current —
  // the DB is only used to dereference the id. If SessionReset rolls back a
  // failed seal/open by deleting the snapshot row, getSnapshot() returns null
  // and we fall through to the next older sealed segment.
  public getSnapshotPrefix(threadId: number): string | null {
    if (!this.resetSnapshotDB) return null;
    const session = this.getSession(threadId);
    for (let i = session.segments.length - 1; i >= 0; i--) {
      const snapshotId = session.segments[i].snapshotId;
      if (!snapshotId) continue;
      const snap = this.resetSnapshotDB.getSnapshot(snapshotId);
      if (snap) return snap.summaryMarkdown;
    }
    return null;
  }

  public getBlindReviewSessionId(threadId: number): string | null {
    return this.getSession(threadId).blindReviewSessionId;
  }

  public getCurrentTopic(threadId: number): string {
    return this.getSession(threadId).currentTopic;
  }

  public setResetInFlight(threadId: number, v: boolean): void {
    this.getSession(threadId).resetInFlight = v;
  }

  public isResetInFlight(threadId: number): boolean {
    return this.getSession(threadId).resetInFlight;
  }

  public isDeliberationInFlight(threadId: number): boolean {
    return this.getSession(threadId).deliberationInFlight;
  }

  // Test-only: lets deliberation-segments.test.ts exercise segment lifecycle
  // without running a full runDeliberation round. Production callers push via
  // the private currentMessages() helper inside runDeliberation.
  public pushMessageForTest(threadId: number, m: CouncilMessage): void {
    this.currentMessages(this.getSession(threadId)).push(m);
  }

  // Open a critique window before the next agent speaks. Resolves to the
  // outcome (submitted | skipped) so the caller can inject the critique into
  // the upcoming agent's context. If critiqueStore is not wired, resolves
  // immediately with a 'disabled' skip.
  private async awaitCritique(
    threadId: number,
    prevAgent: string,
    nextAgent: string,
  ): Promise<CritiqueOutcome> {
    if (!this.critiqueStore) {
      return { kind: 'skipped', reason: 'disabled' };
    }
    // Open the window FIRST so any synchronous handler of the requested event
    // (e.g. an adapter that immediately submits/skips) finds a live window.
    const outcomePromise = this.critiqueStore.open(threadId, {
      prevAgent,
      nextAgent,
      timeoutMs: this.critiqueTimeoutMs,
    });
    this.bus.emit('human-critique.requested', { threadId, prevAgent, nextAgent });
    const outcome = await outcomePromise;
    if (outcome.kind === 'submitted') {
      this.bus.emit('human-critique.submitted', {
        threadId,
        stance: outcome.stance,
        content: outcome.content,
        targetAgent: nextAgent,
      });
    } else {
      this.bus.emit('human-critique.skipped', { threadId, reason: outcome.reason });
    }
    return outcome;
  }

  private async runDeliberation(
    threadId: number,
    message: CouncilMessage,
    intent: IntentType,
    complexity: Complexity,
  ): Promise<void> {
    const session = this.getSession(threadId);

    // Mark deliberation in-flight so SessionReset can refuse to seal a
    // segment that is still growing. Agent responses are pushed into
    // currentMessages mid-round (see the agent turn loop below) and
    // facilitator.intervened events can push async, so the flag must
    // cover the entire method. Cleared in the finally at the end so a
    // thrown agent / send error still releases it and unblocks future
    // /councilreset calls.
    session.deliberationInFlight = true;

    try {
    // Reset per-round critique stats. Segment messages are retained across
    // rounds for context continuity, but collaboration-depth metrics are
    // scoped to THIS round — a user asking a follow-up shouldn't inherit last
    // round's acceptance ratio.
    session.critiqueLog = { agentTurns: 0, humanCritiques: [], stanceShiftsInducedByHuman: 0 };

    // Push human message to current segment
    this.currentMessages(session).push(message);
    session.turnManager.recordHumanTurn();

    // Determine active workers based on current participants
    const activeWorkers = this.workers.filter((w) =>
      session.currentParticipants.includes(w.id),
    );

    // Assign roles
    const agentIds = activeWorkers.map((w) => w.id);
    const stressTestMode = message?.stressTest === true;
    const adversarialMode = message?.adversarialMode;
    const rotationMode = message?.pvgRotate === true;
    let rotationPlantedRole: AdversarialRole | null = null;
    const adversarialDebriefs: AdversarialDebriefRecord[] = [];
    let currentRoles = assignRoles(
      agentIds,
      message.content,
      this.config,
      undefined,
      {
        allowSneaky: stressTestMode || rotationMode,
        allowAdversarial: adversarialMode !== undefined || rotationMode,
      },
    );
    if (stressTestMode && agentIds.length >= 2) {
      currentRoles[pickSneakyTarget(agentIds)] = 'sneaky-prover';
    }
    if (adversarialMode && agentIds.length >= 2) {
      currentRoles[pickSneakyTarget(agentIds)] = ADVERSARIAL_MODE_TO_ROLE[adversarialMode];
    }
    if (rotationMode && agentIds.length >= 2) {
      rotationPlantedRole = pickRandomAdversarialRole();
      const targetAgentId = pickSneakyTarget(agentIds);
      currentRoles[targetAgentId] = rotationPlantedRole;
      for (const id of agentIds) {
        if (id !== targetAgentId) currentRoles[id] = 'critic';
      }
      this.pvgRotateStore.create(threadId, rotationPlantedRole);
    }

    const blindReviewMode = message?.blindReview === true;
    let blindCodes: Map<string, string> | undefined;
    let blindReviewSessionId: string | undefined;
    if (blindReviewMode && agentIds.length >= 2) {
      const rolesMap = new Map(Object.entries(currentRoles));
      const blindReviewResult = this.blindReviewStore.create(threadId, agentIds, rolesMap);
      if ('error' in blindReviewResult) {
        // The first available bot is fine — we just need to send the error somewhere
        const fallbackId = agentIds[0];
        await this.sendFn(fallbackId, `❌ ${blindReviewResult.error}. Use /cancelreview to end the previous round.`, threadId);
        return;
      }
      blindCodes = blindReviewResult.codeToAgentId;
      blindReviewSessionId = blindReviewResult.sessionId;
    }

    // Emit deliberation.started. Topic source: no existing classifier output
    // carries a topic string, so we fall back to the first 80 chars of the
    // human message content (spec §4.5, plan Step 5g).
    const topic = message.content.slice(0, 80);
    session.currentTopic = topic;
    this.bus.emit('deliberation.started', {
      threadId,
      participants: agentIds,
      roles: currentRoles,
      structure: 'free',
      topic,
    });

    // Sequential deliberation: first agent responds to human, second agent responds to both
    const responses: Array<{ worker: AgentWorker; role: AgentRole; response: ProviderResponse }> = [];

    // Hoisted: the snapshot prefix can't change mid-round (reset is user-
    // triggered between rounds), so resolve it once to avoid an SQLite hit per
    // agent turn.
    const snapshotPrefix = this.getSnapshotPrefix(threadId) ?? undefined;

    let prevAgentId: string = HUMAN_SENTINEL;
    for (const worker of activeWorkers) {
      const role = currentRoles[worker.id];

      // Fire the HITL invite BEFORE opening the critique window so adapters
      // can surface it to the user in time to actually act on it. The
      // convergence prompt itself still gets injected later as part of the
      // challenge-prompt build.
      if (session.antiSycophancy.shouldInviteHumanCritique()) {
        this.bus.emit('human-critique.invited', { threadId, trigger: 'convergence' });
      }

      // Human-critique pause: open a window before this agent speaks. If the
      // user submits a critique, inject it one-shot into THIS agent's history
      // + challenge prompt only. We deliberately don't push it onto the
      // current segment so a critique targeted at worker.id doesn't leak into
      // later agents' or later rounds' context.
      const critiqueOutcome = await this.awaitCritique(threadId, prevAgentId, worker.id);
      let injectedCritiqueText: string | undefined;
      let turnCritiqueMsg: CouncilMessage | undefined;
      if (critiqueOutcome.kind === 'submitted') {
        turnCritiqueMsg = makeHumanCritique({
          content: critiqueOutcome.content,
          stance: critiqueOutcome.stance,
          targetAgent: worker.id,
          threadId,
        });
        session.critiqueLog.humanCritiques.push({
          stance: critiqueOutcome.stance,
          // Pessimistic defaults: flipped to true only when a follow-up slice
          // adds NLP detection of agent acknowledgment / angle novelty.
          // Scoring a submitted challenge as accepted+novel before the agent
          // has even responded inflates depth scores artificially.
          acknowledgedByNextAgent: false,
          introducedNovelAngle: false,
        });
        injectedCritiqueText = critiqueOutcome.content;
      }

      // Emit agent.responding
      this.bus.emit('agent.responding', { threadId, agentId: worker.id, role });

      const msgs = this.currentMessages(session);

      // Build challenge prompt from anti-sycophancy
      const lastAgentMsg = [...msgs]
        .reverse()
        .find((m) => m.role === 'agent' && m.agentId !== worker.id);

      let challengePrompt: string | undefined;
      if (lastAgentMsg) {
        challengePrompt = session.antiSycophancy.generateChallengePrompt(lastAgentMsg);
      }

      const convergencePrompt = session.antiSycophancy.checkConvergence();
      if (convergencePrompt) {
        challengePrompt = challengePrompt
          ? `${challengePrompt}\n\n${convergencePrompt}`
          : convergencePrompt;
      }

      if (critiqueOutcome.kind === 'submitted' && injectedCritiqueText) {
        const critiquePrompt = buildCritiquePrompt(critiqueOutcome.stance, injectedCritiqueText);
        challengePrompt = challengePrompt
          ? `${challengePrompt}\n\n${critiquePrompt}`
          : critiquePrompt;
      }

      // Add pattern-detected injection if targeting this worker
      if (session.pendingPatternInjection?.targetAgent === worker.id) {
        const patternPrompt = session.pendingPatternInjection.prompt;
        challengePrompt = challengePrompt
          ? `${challengePrompt}\n\n${patternPrompt}`
          : patternPrompt;
        session.pendingPatternInjection = null;
      }

      const turnHistory = turnCritiqueMsg ? [...msgs, turnCritiqueMsg] : msgs;

      const response = await worker.respond(
        turnHistory,
        role,
        challengePrompt,
        complexity,
        rotationMode,
        snapshotPrefix,
      );

      // Tag turn into blind-review session if active
      if (blindReviewMode) {
        this.blindReviewStore.recordTurn(
          threadId,
          worker.id,
          response.tierUsed ?? 'unknown',
          response.modelUsed ?? 'unknown',
        );
      }

      // Strip adversarial-prover trailers before any broadcast or storage
      const dispatch = processAdversarialResponse(role, worker.id, response.content);
      const storedContent = dispatch.storedContent;
      if (dispatch.debrief) {
        adversarialDebriefs.push(dispatch.debrief);
      }

      if (!response.skip) {
        const agentMsg: CouncilMessage = {
          id: `agent-${worker.id}-${Date.now()}`,
          role: 'agent',
          agentId: worker.id,
          content: storedContent,
          timestamp: Date.now(),
          threadId,
          metadata: {
            assignedRole: currentRoles[worker.id],
            confidence: response.confidence,
            references: response.references,
          },
        };

        // Push to current segment BEFORE next agent — so next agent sees this response
        msgs.push(agentMsg);
        session.turnManager.recordAgentTurn(worker.id);
        session.critiqueLog.agentTurns += 1;
        prevAgentId = worker.id;

        // Send to Telegram immediately
        if (blindCodes) {
          const code = [...blindCodes.entries()].find(([, agentId]) => agentId === worker.id)?.[0];
          const labeledContent = code ? `[${code}]:\n${storedContent}` : storedContent;
          await this.sendFn(agentIds[0], labeledContent, threadId);
        } else {
          await this.sendFn(worker.id, storedContent, threadId);
        }

        const classification = session.antiSycophancy.classifyResponse(storedContent);
        session.antiSycophancy.recordClassification(classification);

        // Emit agent.responded
        this.bus.emit('agent.responded', {
          threadId,
          agentId: worker.id,
          response,
          role,
          classification,
        });
      }

      const responseForStorage =
        storedContent !== response.content
          ? { ...response, content: storedContent }
          : response;
      responses.push({ worker, role, response: responseForStorage });
    }

    if (rotationMode && rotationPlantedRole) {
      const planted = adversarialDebriefs.find((d) => d.role === rotationPlantedRole);
      if (planted) this.pvgRotateStore.attachDebrief(threadId, planted);
    }

    // Rotation mode suppresses debrief broadcast; user sees planted role only after guessing via keyboard.
    if (rotationMode && rotationPlantedRole && this.sendKeyboardFn) {
      const keyboard = buildRotationKeyboard();
      await this.sendKeyboardFn(
        agentIds[0],
        'Which failure mode did the prover use this round?\n(Calibrated = honest)',
        keyboard,
        threadId,
      );
    } else if (adversarialDebriefs.length > 0) {
      const debriefMessage = adversarialDebriefs.map(formatAdversarialDebrief).join('\n');
      await this.sendFn('system-debrief', debriefMessage, threadId);
    }

    // Blind-review: post scoring keyboard after all responses are in
    if (blindCodes && blindCodes.size >= 2 && this.sendKeyboardFn && blindReviewSessionId) {
      const codes = [...blindCodes.keys()];
      const keyboard = buildScoringKeyboard(codes);
      await this.sendKeyboardFn(
        agentIds[0],
        'Score each agent 1-5 based on their contribution above. Identities will be revealed once all are scored.',
        keyboard,
        threadId,
      );
      this.bus.emit('blind-review.started', { threadId, codes, sessionId: blindReviewSessionId });
    }

    const collaborationScore = scoreSession({
      agentTurns: session.critiqueLog.agentTurns,
      humanCritiques: session.critiqueLog.humanCritiques,
      stanceShiftsInducedByHuman: session.critiqueLog.stanceShiftsInducedByHuman,
    });

    // Facilitator summary — ask if user wants another round
    if (!this.facilitatorWorker) {
      // No facilitator, just end
      const lastResponse = responses.filter((r) => !r.response.skip).pop();
      const conclusion = lastResponse
        ? lastResponse.response.content.slice(0, 200)
        : 'No responses generated';
      this.bus.emit('deliberation.ended', { threadId, conclusion, intent, collaborationScore });
      return;
    }

    // Build summary prompt for facilitator
    const recentAgentMsgs = responses
      .filter((r) => !r.response.skip)
      .map((r) => `${r.worker.name}: ${r.response.content}`)
      .join('\n\n---\n\n');

    const scoreLine = formatScoreLine(collaborationScore);
    const summaryMsg: CouncilMessage = {
      id: `facilitator-summary-${Date.now()}`,
      role: 'human',
      content: `以下是本輪討論：\n\n${recentAgentMsgs}\n\n${scoreLine}\n\n請用 200 字以內總結雙方觀點的交集與分歧，然後問用戶是否要再進行一輪辯論。最後附上一行「協作深度：${collaborationScore.level}」。用繁體中文回應。`,
      timestamp: Date.now(),
      threadId,
    };

    try {
      const summaryResponse = await this.facilitatorWorker.respond(
        [summaryMsg],
        'synthesizer',
        undefined,
        complexity,
        false,
        snapshotPrefix,
      );
      if (summaryResponse.content.trim()) {
        await this.sendFn('facilitator', summaryResponse.content, threadId);
      }
    } catch {
      // Facilitator summary failed — skip silently
    }

    // Build conclusion from last agent response
    const lastResponse = responses.filter((r) => !r.response.skip).pop();
    const conclusion = lastResponse
      ? lastResponse.response.content.slice(0, 200)
      : 'No responses generated';

    // Emit deliberation.ended
    this.bus.emit('deliberation.ended', {
      threadId,
      conclusion,
      intent,
      collaborationScore,
    });
    } finally {
      session.deliberationInFlight = false;
    }
  }
}

function formatScoreLine(score: DepthScoreResult): string {
  const pct = (n: number): string => (n * 100).toFixed(0);
  return (
    `本輪協作深度統計（供參考，不要複述給用戶）：` +
    `level=${score.level}, ` +
    `interruptionRate=${pct(score.axisBreakdown.interruptionRate)}%, ` +
    `acceptanceRatio=${pct(score.axisBreakdown.acceptanceRatio)}%, ` +
    `divergence=${pct(score.axisBreakdown.divergenceIntroduced)}%`
  );
}
