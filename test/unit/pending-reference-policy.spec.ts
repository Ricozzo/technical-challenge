import { describe, expect, test } from "bun:test";
import {
  nextPendingReferenceAttemptAt,
  PENDING_REFERENCE_POLICY,
} from "../../src/application/pending-reference-policy";

const t0 = new Date("2026-01-01T00:00:00Z");
const delayAfter = (attempts: number) =>
  nextPendingReferenceAttemptAt(attempts, t0).getTime() - t0.getTime();

describe("política de PENDING_REFERENCE", () => {
  test("o atraso dobra a cada tentativa até o teto de 60s", () => {
    const delays = Array.from({ length: 8 }, (_, attempts) => delayAfter(attempts));
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test("o prazo total até a rejeição é de 242 segundos", () => {
    const total = Array.from({ length: PENDING_REFERENCE_POLICY.maxAttempts }, (_, attempts) =>
      delayAfter(attempts),
    ).reduce((sum, delay) => sum + delay, 0);
    expect(total).toBe(242_000);
  });
});