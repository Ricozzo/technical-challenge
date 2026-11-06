import { DomainError } from "../../domain/errors/domain-errors";

export class InvalidIdempotencyKeyError extends DomainError {
  readonly code = "INVALID_IDEMPOTENCY_KEY";
}

export function parseIdempotencyKey(header: unknown): string {
  if (typeof header !== "string" || header.trim() === "" || header.length > 255) {
    throw new InvalidIdempotencyKeyError(
      "The Idempotency-Key header is required (1 to 255 characters)",
    );
  }
  return header;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}