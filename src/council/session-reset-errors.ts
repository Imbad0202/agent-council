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
