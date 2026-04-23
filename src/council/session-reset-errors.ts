export class BlindReviewActiveError extends Error {
  constructor() {
    super(
      'A blind-review session is pending on this thread. ' +
        'Resolve it via /blindreview reveal or /cancelreview before running /councilreset.',
    );
    this.name = 'BlindReviewActiveError';
  }
}

export class ResetInProgressError extends Error {
  constructor(threadId: number) {
    super(`A /councilreset is already in progress for thread ${threadId}.`);
    this.name = 'ResetInProgressError';
  }
}

export class DeliberationInProgressError extends Error {
  constructor(threadId: number) {
    super(
      `A council deliberation is still in progress for thread ${threadId}. ` +
        `Wait for the current round to finish before running /councilreset.`,
    );
    this.name = 'DeliberationInProgressError';
  }
}

export class EmptySegmentError extends Error {
  constructor() {
    super(
      'No new turns to summarize in the current segment. ' +
        '/councilreset is a no-op until the council deliberates at least once.',
    );
    this.name = 'EmptySegmentError';
  }
}

// Round-16 codex finding [P2-VALIDATION]: SessionReset used to commit
// whatever markdown the facilitator returned. parseSummaryMetadata is
// purely structural — if the LLM emitted "### Decisions" instead of
// "## Decisions" or skipped a section, it silently returned 0/0 and the
// malformed snapshot was still persisted. Snowball: every future
// /councilreset on the thread carried the bad summary forward via
// buildPriorSummariesBlock, so a single LLM format drift poisoned all
// subsequent resets. Throw before persist so the existing nested
// rollback semantics keep the thread in a retry-safe state.
export class MalformedResetSummaryError extends Error {
  public readonly missingSections: string[];
  constructor(missingSections: string[]) {
    super(
      `Facilitator returned a malformed reset summary — missing required H2 section(s): ${missingSections.join(', ')}. ` +
        'Retry /councilreset; if it persists, check the facilitator model / prompt for schema drift.',
    );
    this.name = 'MalformedResetSummaryError';
    this.missingSections = missingSections;
  }
}
