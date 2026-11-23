/** An error whose message is safe to show to the person using the app. */
export class UserFacingError extends Error {
  /** @param {'invalid-argument'|'unauthenticated'|'resource-exhausted'|'failed-precondition'|'unavailable'|'internal'} code */
  constructor(code, message) { super(message); this.code = code; }
}
