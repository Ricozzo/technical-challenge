import { InvalidQueryError } from "./errors";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: seq })).toString("base64url");
}

export function decodeCursor(raw: unknown): string {
  if (typeof raw !== "string") throw new InvalidQueryError("cursor is invalid");
  let parsed: { v?: unknown; s?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidQueryError("cursor is invalid");
  }
  if (parsed?.v !== 1 || typeof parsed.s !== "string" || !/^\d{1,18}$/.test(parsed.s)) {
    throw new InvalidQueryError("cursor is invalid");
  }
  return parsed.s;
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new InvalidQueryError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidQueryError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}