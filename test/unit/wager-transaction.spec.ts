import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager/wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/domain/wager/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/domain/wager/wager-transaction-status";
import { FailureCode } from "../../src/domain/wager/failure-code";
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from "../../src/domain/errors/domain-errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00Z");

const tx = (over: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: "t1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: Kind.Bet,
    money: brl("25.00"),
    now,
    ...over,
  });

const reversal = (kind: Kind) =>
  tx({ kind, externalTransactionId: "ext-2", referenceExternalTransactionId: "ext-1" });

describe("create", () => {
  test("nasce em PENDING", () => {
    const t = tx();
    expect(t.status).toBe(Status.Pending);
    expect(t.isTerminal()).toBe(false);
    expect(t.failureCode).toBeUndefined();
    expect(t.processedAt).toBeUndefined();
  });

  test("OPENING não pode ser submetido de fora", () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referência", (kind) => {
    expect(() => tx({ kind })).toThrow(InvalidTransactionError);
  });

  test("BET não pode ter referência", () => {
    expect(() => tx({ referenceExternalTransactionId: "ext-0" })).toThrow(InvalidTransactionError);
  });

  test("WIN pode referenciar a BET", () => {
    expect(tx({ kind: Kind.Win, referenceExternalTransactionId: "ext-0" }).kind).toBe(Kind.Win);
  });

  test("não pode referenciar a si mesma", () => {
    expect(() =>
      tx({ kind: Kind.Refund, referenceExternalTransactionId: "ext-1" }),
    ).toThrow(InvalidTransactionError);
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(tx({ kind: Kind.Loss, money: brl("0.00") }).kind).toBe(Kind.Loss);
    expect(() => tx({ money: brl("0.00") })).toThrow(InvalidTransactionError);
    expect(() => tx({ kind: Kind.Win, money: brl("0.00") })).toThrow(InvalidTransactionError);
  });
});

describe("createOpening", () => {
  test("cria a transação interna OPENING em PENDING", () => {
    const t = WagerTransaction.createOpening({ id: "t0", walletId: "w1", playerId: "p1", money: brl("1000.00"), now });
    expect(t.kind).toBe(Kind.Opening);
    expect(t.providerId).toBe("internal");
    expect(t.status).toBe(Status.Pending);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("transições válidas", () => {
  test("PENDING -> PROCESSED", () => {
    const t = tx();
    t.markProcessed(undefined, now);
    expect(t.status).toBe(Status.Processed);
    expect(t.processedAt).toEqual(now);
    expect(t.isTerminal()).toBe(true);
  });

  test("PENDING -> REJECTED guarda o failureCode", () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds);
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.isTerminal()).toBe(true);
  });

  test("PENDING -> FAILED", () => {
    const t = tx();
    t.fail(FailureCode.InternalError);
    expect(t.status).toBe(Status.Failed);
    expect(t.isTerminal()).toBe(true);
  });

  test("PENDING -> PENDING_REFERENCE -> PROCESSED guarda a referência", () => {
    const t = reversal(Kind.Refund);
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
    expect(t.isTerminal()).toBe(false);
    t.markProcessed("internal-ref-id", now);
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe("internal-ref-id");
  });

  test("PENDING_REFERENCE pode continuar aguardando", () => {
    const t = reversal(Kind.Rollback);
    t.markPendingReference();
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
  });

  test("PENDING_REFERENCE -> REJECTED quando o prazo esgota", () => {
    const t = reversal(Kind.Refund);
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(Status.Rejected);
  });
});

describe("estados terminais", () => {
  const terminals: Array<[string, () => WagerTransaction]> = [
    ["PROCESSED", () => { const t = tx(); t.markProcessed(undefined, now); return t; }],
    ["REJECTED", () => { const t = tx(); t.reject(FailureCode.InsufficientFunds); return t; }],
    ["FAILED", () => { const t = tx(); t.fail(FailureCode.InternalError); return t; }],
  ];

  test.each(terminals)("%s não aceita mais nenhuma transição", (_name, make) => {
    const t = make();
    expect(() => t.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
  });
});

describe("failure codes", () => {
  test("reject() só aceita código de negócio", () => {
    expect(() => tx().reject(FailureCode.InternalError)).toThrow(InvalidTransactionError);
  });

  test("fail() só aceita código de infraestrutura", () => {
    expect(() => tx().fail(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionError);
  });

  test("REFUND e ROLLBACK não podem ser processados sem referência", () => {
    expect(() => reversal(Kind.Refund).markProcessed(undefined, now)).toThrow(InvalidTransactionError);
  });
});

describe("consultas de domínio", () => {
  test("affectsBalance: false só para LOSS", () => {
    expect(tx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(tx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(tx({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test("requiresReference: true para REFUND e ROLLBACK", () => {
    expect(reversal(Kind.Refund).requiresReference()).toBe(true);
    expect(reversal(Kind.Rollback).requiresReference()).toBe(true);
    expect(tx().requiresReference()).toBe(false);
  });

  test("REFUND só referencia BET", () => {
    const refund = reversal(Kind.Refund);
    expect(refund.acceptsReferenceKind(Kind.Bet)).toBe(true);
    expect(refund.acceptsReferenceKind(Kind.Win)).toBe(false);
    expect(refund.acceptsReferenceKind(Kind.Refund)).toBe(false);
  });

  test("ROLLBACK referencia BET, WIN ou REFUND, e nunca ROLLBACK ou LOSS", () => {
    const rollback = reversal(Kind.Rollback);
    expect(rollback.acceptsReferenceKind(Kind.Bet)).toBe(true);
    expect(rollback.acceptsReferenceKind(Kind.Win)).toBe(true);
    expect(rollback.acceptsReferenceKind(Kind.Refund)).toBe(true);
    expect(rollback.acceptsReferenceKind(Kind.Rollback)).toBe(false);
    expect(rollback.acceptsReferenceKind(Kind.Loss)).toBe(false);
  });

  test("matchesPayload compara o hash", () => {
    const t = tx();
    expect(t.matchesPayload("hash-1")).toBe(true);
    expect(t.matchesPayload("outro")).toBe(false);
  });
});

describe("ledgerDirectionFor", () => {
  test("BET debita; WIN e REFUND creditam", () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(reversal(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("LOSS não tem direção", () => {
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test("ROLLBACK inverte a referência", () => {
    const rollback = reversal(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(tx({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(tx({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(reversal(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  test("ROLLBACK sem referência ou com referência inválida lança erro", () => {
    const rollback = reversal(Kind.Rollback);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => rollback.ledgerDirectionFor(reversal(Kind.Rollback))).toThrow(InvalidTransactionError);
    expect(() => rollback.ledgerDirectionFor(tx({ kind: Kind.Loss }))).toThrow(InvalidTransactionError);
  });
});

describe("rehydrate", () => {
  test("reconstrói um estado terminal sem revalidar", () => {
    const t = WagerTransaction.rehydrate({
      id: "t9",
      providerId: "provider-a",
      externalTransactionId: "ext-9",
      idempotencyKey: "provider-a:ext-9",
      payloadHash: "h",
      walletId: "w1",
      playerId: "p1",
      roundId: "r1",
      gameId: "g1",
      kind: Kind.Bet,
      money: brl("10.00"),
      referenceExternalTransactionId: undefined,
      createdAt: now,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(t.status).toBe(Status.Rejected);
    expect(t.isTerminal()).toBe(true);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});