/** Small error type shared by protocol validators. */
export interface ProtocolErrorOptions {
  code?: string;
  field?: string;
}

export class ProtocolError extends Error {
  readonly code?: string;
  readonly field?: string;

  constructor(message: string, options: ProtocolErrorOptions = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = options.code;
    this.field = options.field;
  }
}

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
