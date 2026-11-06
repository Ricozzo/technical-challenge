/**
 * Política das transações PENDING_REFERENCE (referência que ainda não chegou).
 *
 * `attempts` conta as reavaliações já feitas. Entre a criação e a 1ª reavaliação passam 2s,
 * depois 4s, 8s, 16s, 32s e 60s (teto). A 8ª reavaliação, sem a referência, rejeita a
 * transação com REFERENCE_NOT_FOUND: 2+4+8+16+32+60+60+60 = 242s, cerca de 4 minutos no total.
 */
export const PENDING_REFERENCE_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const;

/** `attempts` é quantas tentativas já foram feitas (0 na primeira vez que fica pendente). */
export function nextPendingReferenceAttemptAt(attempts: number, now: Date): Date {
  const delay = Math.min(
    PENDING_REFERENCE_POLICY.baseDelayMs * 2 ** attempts,
    PENDING_REFERENCE_POLICY.maxDelayMs,
  );
  return new Date(now.getTime() + delay);
}