import { createHash } from "node:crypto";
import type { MoneyProps } from "../domain/money/money";

/** Serializa com as chaves ordenadas em todos os níveis e ignora `undefined`. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface HashableFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function computePayloadHash(fields: HashableFields): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}