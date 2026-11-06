import { describe, expect, test } from "bun:test";
import { canonicalJson, computePayloadHash, type HashableFields } from "../../src/application/payload-hash";

const base: HashableFields = {
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "p1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "r1",
  gameId: "g1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("ordena as chaves em todos os níveis e ignora undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("computePayloadHash", () => {
  test("a ordem das chaves não muda o hash", () => {
    const reordered: HashableFields = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "g1",
      roundId: "r1",
      walletId: base.walletId,
      playerId: "p1",
      externalTransactionId: "tx-1",
      providerId: "provider-a",
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  test("é um SHA-256 em hexadecimal", () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("qualquer campo de negócio diferente muda o hash", () => {
    const hash = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: "25.01", currency: "BRL" } })).not.toBe(hash);
    expect(computePayloadHash({ ...base, kind: "WIN" })).not.toBe(hash);
    expect(computePayloadHash({ ...base, roundId: "r2" })).not.toBe(hash);
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: "tx-0" })).not.toBe(hash);
  });

  test("referência ausente e undefined geram o mesmo hash", () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(base),
    );
  });
});