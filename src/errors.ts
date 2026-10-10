export type ErrorStatus = 400 | 404 | 422 | 502;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ErrorStatus,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}
