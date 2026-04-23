export class BlindReviewActiveError extends Error {
  constructor() {
    super(
      'A blind-review session is pending on this thread. ' +
        'Resolve it via /blindreview reveal or /cancelreview before running /councilreset.',
    );
    this.name = 'BlindReviewActiveError';
  }
}
