import type { EventBus } from '../events/bus.js';
import type { AgentWorker } from '../worker/agent-worker.js';
import type { ResetSnapshotDB } from '../storage/reset-snapshot-db.js';
import type { ArtifactDB } from './artifact-db.js';
import { effectiveResetSnapshots } from './effective-reset-snapshots.js';
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
import { FacilitatorAgent } from './facilitator.js';
import type { FacilitatorInterventionResult } from './facilitator.js';
import { pickRandomAdversarialRole, buildRotationKeyboard } from './pvg-rotate.js';
import { PvgRotateStore } from './pvg-rotate-store.js';
import type { AdversarialRole } from './adversarial-provers.js';
import type { HumanCritiqueStore, CritiqueOutcome } from './human-critique-store.js';
import { makeHumanCritique, type HumanCritiqueStance } from './human-critique.js';
import { buildCritiquePrompt } from './human-critique-prompts.js';
import { scoreSession, type DepthScoreResult } from './collaboration-depth.js';

const DEFAULT_CRITIQUE_TIMEOUT_MS = 30_000;

// v0.5.2 P1-B (codex round-2 [P1]): mid-round facilitator interventions
// were a fire-and-forget listener pre-fix; awaiting them inline made the
// hot path block on the facilitator provider. If the provider stalls, we
// must NOT wedge the round — intervention is best-effort. Time out
// individually and continue the loop. Matches the critique-timeout
// posture (also user-controllable indirectly via facilitator's own
// provider config).
const DEFAULT_FACILITATOR_INTERVENTION_TIMEOUT_MS = 30_000;

function raceWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
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
  // Round-11 codex finding [P1]: a message that has been emitted via
  // EventBus 'message.received' is "in flight" until IntentGate's async
  // classify() resolves and emits 'intent.classified'. EventBus does not
  // await listeners, so this window is invisible to deliberationInFlight
  // (which only flips inside runDeliberation, triggered by intent.classified).
  // We track CouncilMessage.id values here: add on message.received, remove
  // on intent.classified. The reset guard rejects when this set is non-empty.
  // Keying by message.id (not a counter) keeps add/remove 1:1 even if
  // bus events fire out of order or duplicate.
  pendingClassifications: Set<string>;
  // v0.5.2.a codex round-3 P1: IntentGate registers its 'message.received'
  // listener BEFORE DeliberationHandler does (src/index.ts:182 vs :217).
  // When IntentGate's keyword path classifies synchronously, listener order
  // is: IntentGate.classify() → emit 'intent.classified' → our delete fires
  // BEFORE our add fires → message.id is added to pending AFTER its
  // classification already completed. Result: msg.id stuck in pending
  // forever, /councildone PendingClassificationError every time.
  // We track classifications that complete BEFORE the corresponding add by
  // recording message.ids on intent.classified; the message.received listener
  // checks this set and skips the add if classification already fired.
  // Bounded growth: removed when consumed by the corresponding add, so the
  // set holds at most one entry per in-flight race window.
  recentlyClassified: Set<string>;
  // True while ArtifactService.synthesize is mid-flight for this thread.
  // runDeliberation checks this before running agents so deliberation cannot
  // append new messages to a segment that /councildone is actively reading.
  // Cleared by ArtifactService after the LLM call (success or error).
  synthesisInFlight: boolean;
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
  // v0.5.2.a codex round-4 P2: getSnapshotPrefix needs to know if a thread
  // has a /councildone artifact sealed AFTER its latest reset, to suppress
  // stale reset-summary leakage past the artifact closing primitive.
  private artifactDB: ArtifactDB | undefined;
  private facilitatorIntervention:
    | {
        recordAgentResponse: (threadId: number, agentId: string, content: string) => void;
        evaluateIntervention: (threadId: number) => Promise<FacilitatorInterventionResult | null>;
      }
    | undefined;
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
      // v0.5.2.a codex round-4 P2: optional ArtifactDB so getSnapshotPrefix
      // can suppress stale reset-summary leakage past /councildone boundary.
      // Optional: handlers without artifactDB (legacy / pre-v0.5.2.a tests)
      // simply behave as before.
      artifactDB?: ArtifactDB;
      // v0.5.2 P1-B: optional facilitator-driven intervention hook. When set,
      // runDeliberation calls these inline after every agent.responded emit so
      // the LLM call resolves WITHIN the deliberationInFlight window. Narrow
      // interface (not the FacilitatorAgent class) so tests can stub without
      // wiring the full agent. Both methods are optional individually for the
      // same reason — recordAgentResponse without evaluateIntervention is a
      // no-op-equivalent that still satisfies the contract.
      facilitatorIntervention?: {
        recordAgentResponse: (threadId: number, agentId: string, content: string) => void;
        evaluateIntervention: (threadId: number) => Promise<FacilitatorInterventionResult | null>;
      };
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
    this.artifactDB = options?.artifactDB;
    // v0.5.2 P1-B (codex rounds 1-2):
    // - Round-1: a caller wiring only facilitatorWorker silently lost
    //   mid-round steer/challenge interventions when the agent.responded
    //   listener was removed.
    // - Round-2 [P2]: even after default-wiring the hook from
    //   facilitatorWorker, if the caller also supplies an explicit
    //   facilitatorIntervention we MUST still create the FacilitatorAgent
    //   so the other listeners (deliberation.started structure announce,
    //   pattern.detected, convergence.detected, deliberation.ended history
    //   cleanup) keep working. Otherwise a "narrow override" silently
    //   disables four unrelated facilitator behaviors.
    // Always instantiate when facilitatorWorker is present; the explicit
    // hook only overrides the mid-round intervention path.
    if (options?.facilitatorWorker) {
      const agent = new FacilitatorAgent(bus, options.facilitatorWorker);
      this.facilitatorIntervention =
        options.facilitatorIntervention ?? {
          recordAgentResponse: (threadId, agentId, content) =>
            agent.recordAgentResponse(threadId, agentId, content),
          evaluateIntervention: (threadId) => agent.evaluateIntervention(threadId),
        };
    } else {
      this.facilitatorIntervention = options?.facilitatorIntervention;
    }

    // Subscribe to intent.classified — skip 'meta' intent
    this.bus.on('intent.classified', (payload) => {
      if (payload.intent === 'meta') return;
      this.runDeliberation(payload.threadId, payload.message, payload.intent, payload.complexity);
    });

    // v0.5.2 P1-B option C (codex round-3 [P1]): the facilitator.intervened
    // listener used to push facilitator messages into currentMessages. That
    // was the last surviving "async listener mutates session state" path —
    // and even with the round-2 timeout swallow, a slow LLM call could still
    // resolve in the background, emit facilitator.intervened, and have the
    // listener push into a segment that /councilreset had since sealed.
    //
    // The fix: ALL writes to currentMessages from facilitator interventions
    // now go through the inline path in runDeliberation, which executes
    // synchronously while deliberationInFlight is true. Late LLM emits
    // (post-timeout, post-deliberation.ended) reach the bus but no listener
    // pushes them into segments. Router still listens for downstream
    // broadcast (router.ts) — that's harmless display-only side-effect.
    //
    // 'structure' announcements from FacilitatorAgent.announceStructure are
    // also display-only — they were already filtered out here, so dropping
    // the listener loses no behaviour for them.

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

    // Round-11 codex finding [P1]: track classifications-in-flight so the
    // reset guard sees messages that have been emitted but not yet
    // classified. Materialize the session via getSession (not sessions.get)
    // because message.received is the first event a brand-new thread will
    // see — sessions.get would no-op and the marker would be lost.
    //
    // v0.5.2.a codex round-3 P1: IntentGate's listener is registered before
    // ours (src/index.ts:182 IntentGate, :217 DeliberationHandler), so when
    // IntentGate takes its synchronous keyword path it emits intent.classified
    // BEFORE our add-pending listener has run. We use recentlyClassified to
    // detect that ordering and skip the stale add.
    this.bus.on('message.received', ({ message, threadId }) => {
      const session = this.getSession(threadId);
      if (session.recentlyClassified.has(message.id)) {
        // Race: intent.classified already fired before this add. Consume
        // the marker and skip the add — the classification is complete, the
        // message must NOT linger in pendingClassifications.
        session.recentlyClassified.delete(message.id);
        return;
      }
      session.pendingClassifications.add(message.id);
    });
    this.bus.on('intent.classified', ({ message, threadId }) => {
      const session = this.getSession(threadId);
      if (session.pendingClassifications.has(message.id)) {
        // Normal order: add fired first, classification consumes the marker.
        session.pendingClassifications.delete(message.id);
      } else {
        // Race: classification fired before our add. Mark for the add
        // listener to consume so it knows to skip.
        session.recentlyClassified.add(message.id);
      }
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
        pendingClassifications: new Set(),
        recentlyClassified: new Set(),
        synthesisInFlight: false,
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

  // HandlerForArtifact adapter — returns the shape ArtifactService expects.
  public getCurrentSegment(threadId: number): { messages: readonly CouncilMessage[] } {
    return { messages: this.getCurrentSegmentMessages(threadId) };
  }

  public sealCurrentSegment(threadId: number, snapshotId: string | null): void {
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
    // Round-13 codex finding [P2-X]: topic is segment-level. Clear it
    // here so the next segment's first human turn re-initialises it
    // (runDeliberation only writes when currentTopic === '').
    session.currentTopic = '';

    // Round-14 codex finding [P2-V]: AntiSycophancyEngine's classification
    // history is segment-level too. If the sealed segment ended in an
    // agreement streak, leaving the state intact would make the first
    // post-reset round fire a convergence prompt / HITL invite based on
    // the OLD segment. Reset the engine so the new segment starts from a
    // neutral convergence state. Matches the currentTopic clear above:
    // reset boundary == "forget segment-scoped heuristic state."
    session.antiSycophancy.reset();
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
  // Live segment state is preferred source of truth for which snapshot is
  // current — the DB is used to dereference the id. If SessionReset rolls
  // back a failed seal/open by deleting the snapshot row, getSnapshot()
  // returns null and we fall through to the next older sealed segment.
  //
  // Round-9 codex finding [P2]: after a process restart the in-memory
  // session rebuilds with a fresh open segment (snapshotId null), so the
  // in-memory walk misses the snapshot row that still lives in SQLite.
  // Fall back to the DB's most recent snapshot for this thread so the
  // carry-forward feature survives restart — which is the whole point.
  public getSnapshotPrefix(threadId: number): string | null {
    if (!this.resetSnapshotDB) return null;
    const session = this.getSession(threadId);
    for (let i = session.segments.length - 1; i >= 0; i--) {
      const seg = session.segments[i];
      // v0.5.2.a codex round-4 P2: a sealed segment with null snapshotId is
      // an /councildone artifact boundary (only `unsealCurrentSegment` also
      // produces null, but it pairs with endedAt=null — i.e. the segment
      // becomes unsealed again). The artifact is the closing primitive per
      // spec §0; older reset summaries must NOT leak through it. Stop the
      // traversal and return null. Workers in segments after a /councildone
      // start with a clean prior context (or whatever segment-2's
      // deliberation produces), as designed.
      if (seg.endedAt !== null && !seg.snapshotId) {
        return null;
      }
      const snapshotId = seg.snapshotId;
      if (!snapshotId) continue;
      const snap = this.resetSnapshotDB.getSnapshot(snapshotId);
      if (snap) return snap.summaryMarkdown;
    }
    // Post-restart DB fallback. Use the cross-cutting artifact-boundary
    // filter (effectiveResetSnapshots) so any reset snapshot SUPERSEDED by
    // a later /councildone is dropped. Spec §0: artifact is the closing
    // primitive; older reset summaries must NOT leak through it.
    const effective = effectiveResetSnapshots(threadId, this.resetSnapshotDB, this.artifactDB);
    if (effective.length > 0) {
      return effective[effective.length - 1].summaryMarkdown;
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

  public setSynthesisInFlight(threadId: number, value: boolean): void {
    this.getSession(threadId).synthesisInFlight = value;
  }

  public isSynthesisInFlight(threadId: number): boolean {
    return this.getSession(threadId).synthesisInFlight;
  }

  public isDeliberationInFlight(threadId: number): boolean {
    return this.getSession(threadId).deliberationInFlight;
  }

  public hasPendingClassifications(threadId: number): boolean {
    return this.getSession(threadId).pendingClassifications.size > 0;
  }

  // Test-only: lets deliberation-segments.test.ts exercise segment lifecycle
  // without running a full runDeliberation round. Production callers push via
  // the private currentMessages() helper inside runDeliberation.
  public pushMessageForTest(threadId: number, m: CouncilMessage): void {
    this.currentMessages(this.getSession(threadId)).push(m);
  }

  // Test-only accessors for round-14 P2-V (AntiSycophancyEngine state must
  // be cleared on openNewSegment). Production code consults the convergence
  // state via AntiSycophancyEngine.shouldInviteHumanCritique /
  // checkConvergence inside runDeliberation; exposing the boolean through
  // the handler lets the segment-boundary test assert the leak is plugged
  // without having to exercise a full round.
  public injectAntiSycophancyClassificationsForTest(
    threadId: number,
    classifications: ResponseClassification[],
  ): void {
    const engine = this.getSession(threadId).antiSycophancy;
    for (const c of classifications) {
      engine.recordClassification(c);
    }
  }

  public isConvergingForTest(threadId: number): boolean {
    return this.getSession(threadId).antiSycophancy.shouldInviteHumanCritique();
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

    // Round-9 codex finding [P1]: round-7 only added the "reset refuses
    // during deliberation" direction. Without this symmetric guard, a
    // human message arriving while /councilreset is waiting on the
    // facilitator summary would be pushed into the segment that's about
    // to be sealed, so the persisted snapshot diverges from the sealed
    // transcript. Drop the message with a user-facing notice instead of
    // queuing — the new segment opens right after the reset finishes
    // and the user can retype.
    if (session.resetInFlight) {
      // Hardcode 'facilitator' (not workers[0].id) — this is a system notice,
      // not a response from any specific agent. Matches the convention used
      // for facilitator.intervened / facilitator summary messages.
      await this.sendFn(
        'facilitator',
        '⏳ /councilreset is in progress on this thread. Your message was not picked up — please resend once the reset confirmation lands.',
        threadId,
      );
      return;
    }

    // v0.5.2.a: /councildone sets synthesisInFlight while the artifact LLM
    // call is reading the current segment. Deliberation must not append new
    // messages to a segment that is being consumed — the resulting artifact
    // would diverge from the sealed transcript. Drop with a user-facing notice;
    // the user can resend once /councildone finishes and clears the flag.
    if (session.synthesisInFlight) {
      await this.sendFn(
        'facilitator',
        '⏳ /councildone synthesis is in progress on this thread. Your message was not picked up — please resend once the artifact is ready.',
        threadId,
      );
      return;
    }

    // Mark deliberation in-flight so SessionReset can refuse to seal a
    // segment that is still growing. Agent responses are pushed into
    // currentMessages mid-round (see the agent turn loop below) and
    // facilitator.intervened events can push async, so the flag must
    // cover the entire method. Cleared in the finally at the end so a
    // thrown agent / send error still releases it and unblocks future
    // /councilreset calls.
    session.deliberationInFlight = true;

    // Hoisted for finally-block rollback (round-12 P1-A). blindReviewSessionId
    // is set when BlindReviewStore.create() succeeds; blindReviewKeyboardSent
    // flips true only after the scoring keyboard posts AND blind-review.started
    // is emitted. The finally treats undefined sessionId as "no rollback
    // needed" and any non-undefined + !sent combination as "rollback".
    let blindReviewSessionId: string | undefined;
    let blindReviewKeyboardSent = false;

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
    // blindReviewSessionId / blindReviewKeyboardSent are hoisted above the
    // try block so the finally can roll back when an early await throws
    // (round-12 P1-A).
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
      // Round-11 codex finding [P2]: set the per-thread guard NOW, not via
      // the 'blind-review.started' event listener that only fires after
      // sendKeyboardFn succeeds. Otherwise a Telegram send failure leaves
      // the store populated (refusing fresh /blindreview) while the guard
      // reads null (wrongly allowing /councilreset). The 'started'
      // listener stays in place because tests + telemetry consumers also
      // listen on it; setting the field here just removes the inconsistency
      // window. Re-assigning it later via the listener is idempotent.
      session.blindReviewSessionId = blindReviewSessionId;
    }

    // Emit deliberation.started. Topic source: no existing classifier output
    // carries a topic string, so we fall back to the first 80 chars of the
    // human message content (spec §4.5, plan Step 5g).
    //
    // Round-13 codex finding [P2-X]: topic is SEGMENT-level, not turn-level.
    // SessionReset frames the reset summary around session.currentTopic; if
    // every round overwrites it, a multi-round segment whose last follow-up
    // was a narrow question ("what about tests?") would bias the summary
    // away from the segment's actual subject. Only initialise on the first
    // human turn of a new segment (currentTopic === ''); openNewSegment
    // clears it back to '' for the next segment. The per-round event payload
    // still uses the latest message hint so listeners can react to the
    // immediate prompt.
    const turnTopic = message.content.slice(0, 80);
    if (session.currentTopic === '') {
      session.currentTopic = turnTopic;
    }
    this.bus.emit('deliberation.started', {
      threadId,
      participants: agentIds,
      roles: currentRoles,
      structure: 'free',
      topic: turnTopic,
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

        // v0.5.2 P1-B option C: drive facilitator intervention inline AND
        // push the result into currentMessages from this synchronous flow.
        // evaluateIntervention now RETURNS the decision instead of emitting
        // it from inside the LLM callback. That means a late LLM resolution
        // (post-timeout, post-deliberation.ended) cannot push into a sealed
        // segment — there is no listener that would do the push, and the
        // caller already moved on. Single-owner mutation: this block is the
        // only place facilitator messages enter currentMessages.
        if (this.facilitatorIntervention) {
          // Wrap both hook calls so a custom implementation that throws
          // synchronously (e.g. a non-async evaluateIntervention or a
          // recordAgentResponse that throws) cannot wedge the round
          // before the .catch on raceWithTimeout has a chance to fire.
          // (codex round-4 [P3])
          try {
            this.facilitatorIntervention.recordAgentResponse(
              threadId,
              worker.id,
              storedContent,
            );
          } catch (err) {
            console.error(
              `[deliberation] facilitator recordAgentResponse threw for thread ${threadId}:`,
              err instanceof Error ? err.message : err,
            );
          }

          // Time-bound the intervention so a hung facilitator provider
          // can't wedge the deliberation loop. Errors and timeouts are
          // both swallowed with a console warning — intervention is
          // best-effort, the round must finish. Promise.resolve().then()
          // normalises sync throws from a non-async hook implementation
          // into rejected promises so .catch() handles both paths.
          const intervention = await raceWithTimeout(
            Promise.resolve().then(() =>
              this.facilitatorIntervention!.evaluateIntervention(threadId),
            ),
            DEFAULT_FACILITATOR_INTERVENTION_TIMEOUT_MS,
            `facilitator intervention timed out after ${DEFAULT_FACILITATOR_INTERVENTION_TIMEOUT_MS}ms`,
          ).catch((err) => {
            console.error(
              `[deliberation] mid-round facilitator intervention failed for thread ${threadId}, agent ${worker.id}:`,
              err instanceof Error ? err.message : err,
            );
            return null;
          });

          if (intervention) {
            // Push to currentMessages first so the next agent in the loop
            // sees the intervention as part of context, then emit for
            // router / Telegram broadcast.
            const facilitatorMsg: CouncilMessage = {
              id: `facilitator-${Date.now()}`,
              role: 'agent',
              agentId: 'facilitator',
              content: intervention.content,
              timestamp: Date.now(),
              threadId,
              metadata: { assignedRole: 'synthesizer' },
            };
            this.currentMessages(session).push(facilitatorMsg);
            this.bus.emit('facilitator.intervened', {
              threadId,
              action: intervention.action,
              content: intervention.content,
              ...(intervention.targetAgent ? { targetAgent: intervention.targetAgent } : {}),
            });
          }
        }
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
      // Round-11 codex finding [P2]: if Telegram rejects this send (rate
      // limit, network blip, bot down), the BlindReviewStore session is
      // already populated and the per-thread guard is already set (round-11
      // sibling fix above moved that earlier). Without this rollback the
      // thread is wedged: /blindreview is rejected as "pending session
      // exists" AND /councilreset is wrongly blocked. Roll both back so
      // the user can retry cleanly.
      try {
        await this.sendKeyboardFn(
          agentIds[0],
          'Score each agent 1-5 based on their contribution above. Identities will be revealed once all are scored.',
          keyboard,
          threadId,
        );
        this.bus.emit('blind-review.started', { threadId, codes, sessionId: blindReviewSessionId });
        blindReviewKeyboardSent = true;
      } catch (err) {
        // The finally block at the bottom of runDeliberation rolls back the
        // store + guard (round-12 P1-A makes that the single rollback path).
        // Here we only surface the keyboard-specific user-facing notice.
        await this.sendFn(
          'facilitator',
          `❌ Failed to post scoring keyboard: ${err instanceof Error ? err.message : String(err)}. Blind-review session cleared — please retry.`,
          threadId,
        );
      }
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
      // Round-13 codex finding [P2-Y]: do NOT pass snapshotPrefix here.
      // summaryMsg already contains only the current round's transcript;
      // prepending the prior segment's snapshot would frame the user-facing
      // 「本輪討論」 reply around stale decisions from the sealed segment.
      // Peer agents (claude/openai) still get snapshotPrefix on their own
      // respond() calls above — that's the carry-forward path.
      const summaryResponse = await this.facilitatorWorker.respond(
        [summaryMsg],
        'synthesizer',
        undefined,
        complexity,
        false,
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
      // Round-12 codex finding [P1-A]: single rollback path for blind-review
      // state. If the round started a blind-review session but never made it
      // to a successful keyboard post (any await above threw, or the
      // sendKeyboard catch fired), clear both the store entry and the
      // per-thread guard so a fresh /blindreview is accepted and
      // /councilreset is no longer wrongly blocked.
      if (blindReviewSessionId !== undefined && !blindReviewKeyboardSent) {
        this.blindReviewStore.delete(threadId);
        session.blindReviewSessionId = null;
      }
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
