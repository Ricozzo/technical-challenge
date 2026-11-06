import { ConcurrentModificationError } from "./errors";

export type LockConflictReason =
  | "version_mismatch"
  | "deadlock"
  | "serialization_failure"
  | "lock_timeout";

/** SQLSTATE do PostgreSQL para as falhas de concorrência. */
const SQLSTATE_REASON: Record<string, LockConflictReason> = {
  "40P01": "deadlock",
  "40001": "serialization_failure",
  "55P03": "lock_timeout",
};

/**
 * Reconhece um conflito de lock, mesmo embrulhado por outro erro (o ORM costuma embrulhar).
 * Esperar pelo lock é o funcionamento normal e não é um conflito: isso aparece em
 * wallet_lock_wait_seconds. Conflito é quando a concorrência de fato falhou.
 */
export function classifyLockConflict(error: unknown): LockConflictReason | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof ConcurrentModificationError) return "version_mismatch";
    const code = (current as { code?: unknown }).code;
    const reason = typeof code === "string" ? SQLSTATE_REASON[code] : undefined;
    if (reason) return reason;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}