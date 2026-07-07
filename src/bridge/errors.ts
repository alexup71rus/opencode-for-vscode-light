/**
 * Standalone error type for OpenCode client failures, kept in a separate
 * module so it can be imported by tests and services without pulling in the
 * full SDK (the SDK's `exports` map doesn't resolve under tsx, which breaks
 * the test runner — see test/permissionSync.test.ts).
 */
export class OpenCodeClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OpenCodeClientError";
  }
}
