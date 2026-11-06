/**
 * Política das transações PENDING_REFERENCE (referência que ainda não chegou).
 * Atrasos: 2s, 4s, 8s, 16s, 32s, 60s, 60s. Depois da 8ª tentativa a transação é
 * rejeitada com REFERENCE_NOT_FOUND, no total cerca de 3 minutos.
 */
export const PENDING_REFERENCE_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const;

export function nextPendingReferenceAttemptAt(attempts: number, now: Date): Date {
  const delay = Math.min(
    PENDING_REFERENCE_POLICY.baseDelayMs * 2 ** attempts,
    PENDING_REFERENCE_POLICY.maxDelayMs,
  );
  return new Date(now.getTime() + delay);
}