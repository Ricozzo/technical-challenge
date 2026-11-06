import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/application/errors";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet";
import {
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from "../../src/application/use-cases/process-wager-transaction";
import { InvalidMoneyError, InvalidTransactionError } from "../../src/domain/errors/domain-errors";
import { FailureCode } from "../../src/domain/wager/failure-code";
import { WagerTransactionStatus as Status } from "../../src/domain/wager/wager-transaction-status";
import { createTestContext, type TestContext } from "../helpers/test-database";

let ctx: TestContext;
let openWallet: OpenWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  ctx = await createTestContext();
  openWallet = new OpenWalletUseCase({ uow: ctx.uow });
  processTx = new ProcessWagerTransactionUseCase({ uow: ctx.uow });
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

// Helpers

type W = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: "BRL" });

let walletSeq = 0;
async function newWallet(balance = "100.00"): Promise<W> {
  const r = await openWallet.execute({ playerId: `player-${++walletSeq}`, initialBalance: brl(balance) });
  return { id: r.id, playerId: r.playerId };
}

let extSeq = 0;
function command(w: W, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  const ext = over.externalTransactionId ?? `ext-${++extSeq}`;
  return {
    idempotencyKey: `provider-a:${ext}`,
    providerId: "provider-a",
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: brl("25.00"),
    ...over,
  };
}

const amountOf = (r: ProcessWagerTransactionResult) => r.balance?.toJSON().amount;

async function walletBalance(id: string): Promise<string> {
  const wallet = await ctx.uow.run((r) => r.wallets.findById(id));
  return wallet!.balance.toJSON().amount;
}

async function ledgerEntries(walletId: string, direction?: string): Promise<number> {
  const rows = (await ctx.orm.em.execute(
    `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? ${direction ? "and direction = ?" : ""}`,
    direction ? [walletId, direction] : [walletId],
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function expectInvariant(walletId: string) {
  const wallet = await ctx.uow.run((r) => r.wallets.findById(walletId));
  const rebuilt = await ctx.uow.run((r) => r.ledger.reconstructBalance(walletId, "BRL"));
  expect(rebuilt.balance.equals(wallet!.balance)).toBe(true);
}

// Wallet

describe("abertura de wallet", () => {
  test("saldo inicial gera OPENING, lançamento CREDIT e evento", async () => {
    const w = await newWallet("1000.00");
    expect(await walletBalance(w.id)).toBe("1000.00");
    expect(await ledgerEntries(w.id, "CREDIT")).toBe(1);
    expect(await ctx.eventTypes()).toEqual(["WalletBalanceChanged"]);
    await expectInvariant(w.id);
  });

  test("saldo inicial zero não gera lançamento", async () => {
    const w = await newWallet("0.00");
    expect(await ledgerEntries(w.id)).toBe(0);
    await expectInvariant(w.id);
  });

  test("wallet duplicada para o mesmo player e moeda é conflito", async () => {
    await openWallet.execute({ playerId: "same", initialBalance: brl("10.00") });
    await expect(
      openWallet.execute({ playerId: "same", initialBalance: brl("10.00") }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });
});

// Regras básicas

describe("BET, WIN e LOSS", () => {
  test("BET debita e gera lançamento DEBIT", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(command(w));
    expect(r.status).toBe(Status.Processed);
    expect(amountOf(r)).toBe("75.00");
    expect(r.idempotentReplay).toBe(false);
    expect(await ledgerEntries(w.id, "DEBIT")).toBe(1);
    await expectInvariant(w.id);
  });

  test("BET sem saldo é REJECTED, auditável, e não gera lançamento", async () => {
    const w = await newWallet("10.00");
    const r = await processTx.execute(command(w));
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletBalance(w.id)).toBe("10.00");
    expect(await ledgerEntries(w.id, "DEBIT")).toBe(0);
    expect(await ctx.count("wager_transactions")).toBe(2);
    expect(await ctx.eventTypes()).toContain("WagerTransactionRejected");
  });

  test("WIN credita", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(command(w, { kind: "WIN", money: brl("40.00") }));
    expect(r.status).toBe(Status.Processed);
    expect(amountOf(r)).toBe("140.00");
    await expectInvariant(w.id);
  });

  test("LOSS não move saldo, não gera lançamento e não emite WalletBalanceChanged", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(command(w, { kind: "LOSS", money: brl("0.00") }));
    expect(r.status).toBe(Status.Processed);
    expect(amountOf(r)).toBe("100.00");
    expect(await ledgerEntries(w.id)).toBe(1);
    expect(await ctx.eventTypes()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await expectInvariant(w.id);
  });
});

// Idempotência

describe("idempotência", () => {
  test("replay devolve o resultado original, inclusive o saldo observado naquele momento", async () => {
    const w = await newWallet("100.00");
    const bet1 = command(w, { externalTransactionId: "bet-1" });
    const first = await processTx.execute(bet1);
    await processTx.execute(command(w, { externalTransactionId: "bet-2" }));

    const replay = await processTx.execute(bet1);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(amountOf(replay)).toBe("75.00");
    expect(await walletBalance(w.id)).toBe("50.00");
    expect(await ledgerEntries(w.id, "DEBIT")).toBe(2);
  });

  test("a mesma key com payload diferente é conflito, e não replay", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    await expect(
      processTx.execute(command(w, { externalTransactionId: "bet-1", money: brl("99.00") })),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(await walletBalance(w.id)).toBe("75.00");
  });

  test("replay de uma transação rejeitada devolve a mesma rejeição", async () => {
    const w = await newWallet("10.00");
    const cmd = command(w);
    const first = await processTx.execute(cmd);
    const replay = await processTx.execute(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(Status.Rejected);
    expect(replay.failureCode).toBe(first.failureCode);
  });
});

// Validação

describe("payload inválido", () => {
  test("não grava nada", async () => {
    const w = await newWallet("100.00");
    await expect(processTx.execute(command(w, { money: brl("25.123") }))).rejects.toThrow(InvalidMoneyError);
    await expect(processTx.execute(command(w, { kind: "OPENING" }))).rejects.toThrow(InvalidTransactionError);
    await expect(processTx.execute(command(w, { kind: "NOPE" }))).rejects.toThrow(InvalidTransactionError);
    await expect(processTx.execute(command(w, { kind: "REFUND" }))).rejects.toThrow(InvalidTransactionError);
    await expect(processTx.execute(command(w, { walletId: "not-a-uuid" }))).rejects.toThrow(InvalidTransactionError);
    expect(await ctx.count("wager_transactions")).toBe(1);
  });

  test("wallet inexistente", async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: "ghost" };
    await expect(processTx.execute(command(ghost))).rejects.toThrow(WalletNotFoundError);
  });

  test("moeda diferente da wallet é REJECTED e fica gravada", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(command(w, { money: { amount: "10.00", currency: "USD" } }));
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await walletBalance(w.id)).toBe("100.00");
    expect(await ctx.count("wager_transactions")).toBe(2);
  });

  test("player diferente do dono da wallet é REJECTED", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(command(w, { playerId: "outro-player" }));
    expect(r.failureCode).toBe(FailureCode.PlayerMismatch);
  });
});

// Reversões

describe("REFUND e ROLLBACK", () => {
  const reversal = (w: W, kind: string, ext: string, ref: string, over: Partial<ProcessWagerTransactionCommand> = {}) =>
    command(w, { kind, externalTransactionId: ext, referenceExternalTransactionId: ref, ...over });

  test("REFUND devolve a aposta uma única vez", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));

    const refund = await processTx.execute(reversal(w, "REFUND", "refund-1", "bet-1"));
    expect(refund.status).toBe(Status.Processed);
    expect(amountOf(refund)).toBe("100.00");

    const again = await processTx.execute(reversal(w, "REFUND", "refund-2", "bet-1"));
    expect(again.failureCode).toBe(FailureCode.AlreadyReversed);

    const rollback = await processTx.execute(reversal(w, "ROLLBACK", "rb-1", "bet-1"));
    expect(rollback.failureCode).toBe(FailureCode.AlreadyReversed);

    expect(await walletBalance(w.id)).toBe("100.00");
    await expectInvariant(w.id);
  });

  test("ROLLBACK de BET credita; de WIN debita; de REFUND debita", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    await processTx.execute(command(w, { kind: "WIN", externalTransactionId: "win-1", money: brl("50.00") }));

    const rbBet = await processTx.execute(reversal(w, "ROLLBACK", "rb-bet", "bet-1"));
    expect(amountOf(rbBet)).toBe("150.00");

    const rbWin = await processTx.execute(reversal(w, "ROLLBACK", "rb-win", "win-1", { money: brl("50.00") }));
    expect(amountOf(rbWin)).toBe("100.00");

    await processTx.execute(command(w, { externalTransactionId: "bet-2" }));
    await processTx.execute(reversal(w, "REFUND", "refund-2", "bet-2"));
    const rbRefund = await processTx.execute(reversal(w, "ROLLBACK", "rb-refund", "refund-2"));
    expect(amountOf(rbRefund)).toBe("75.00");

    await expectInvariant(w.id);
  });

  test("reversão que deixaria saldo negativo é rejeitada com código próprio", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(command(w, { kind: "WIN", externalTransactionId: "win-1", money: brl("50.00") }));
    await processTx.execute(command(w, { externalTransactionId: "bet-1", money: brl("140.00") })); // 10

    const r = await processTx.execute(reversal(w, "ROLLBACK", "rb-1", "win-1", { money: brl("50.00") }));
    expect(r.status).toBe(Status.Rejected);
    expect(r.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(r.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await walletBalance(w.id)).toBe("10.00");
    await expectInvariant(w.id);
  });

  test("valor diferente da referência, tipo não permitido e rodada diferente", async () => {
    const w = await newWallet("200.00");
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    await processTx.execute(command(w, { kind: "WIN", externalTransactionId: "win-1", money: brl("10.00") }));

    const amount = await processTx.execute(reversal(w, "REFUND", "r1", "bet-1", { money: brl("10.00") }));
    expect(amount.failureCode).toBe(FailureCode.AmountMismatch);

    const kind = await processTx.execute(reversal(w, "REFUND", "r2", "win-1", { money: brl("10.00") }));
    expect(kind.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);

    const round = await processTx.execute(reversal(w, "REFUND", "r3", "bet-1", { roundId: "round-2" }));
    expect(round.failureCode).toBe(FailureCode.ReferenceMismatch);

    await expectInvariant(w.id);
  });

  test("a referência foi rejeitada: não há o que reverter", async () => {
    const w = await newWallet("10.00");
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    const r = await processTx.execute(reversal(w, "REFUND", "refund-1", "bet-1"));
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test("referência fora de ordem vira PENDING_REFERENCE e não mexe no saldo", async () => {
    const w = await newWallet("100.00");
    const r = await processTx.execute(reversal(w, "REFUND", "refund-1", "bet-que-nao-chegou"));
    expect(r.status).toBe(Status.PendingReference);
    expect(r.balance).toBeUndefined();
    expect(await walletBalance(w.id)).toBe("100.00");
    expect(await ctx.eventTypes()).toContain("WagerTransactionPendingReference");

    const replay = await processTx.execute(reversal(w, "REFUND", "refund-1", "bet-que-nao-chegou"));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(Status.PendingReference);
  });
});

// Concorrência

describe("concorrência", () => {
  test("saldo 100.00 e duas apostas de 80.00 em paralelo: uma passa, a outra é rejeitada", async () => {
    const w = await newWallet("100.00");
    const results = await Promise.all([
      processTx.execute(command(w, { money: brl("80.00") })),
      processTx.execute(command(w, { money: brl("80.00") })),
    ]);

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await walletBalance(w.id)).toBe("20.00");
    expect(await ledgerEntries(w.id, "DEBIT")).toBe(1);
    await expectInvariant(w.id);
  }, 30_000);

  test("a mesma aposta enviada 50 vezes em paralelo gera um único débito", async () => {
    const w = await newWallet("100.00");
    const cmd = command(w, { externalTransactionId: "bet-dup" });

    const results = await Promise.all(Array.from({ length: 50 }, () => processTx.execute(cmd)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    expect(results.every((r) => amountOf(r) === "75.00")).toBe(true);

    expect(await walletBalance(w.id)).toBe("75.00");
    expect(await ledgerEntries(w.id, "DEBIT")).toBe(1);
    await expectInvariant(w.id);
  }, 30_000);

  test("wallets distintas são processadas em paralelo, cada uma com o seu saldo", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet("100.00")));

    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 8 }, () => processTx.execute(command(w)))),
    );

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(20);
    expect(results.filter((r) => r.status === Status.Rejected)).toHaveLength(20);

    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe("0.00");
      expect(await ledgerEntries(w.id, "DEBIT")).toBe(4);
      await expectInvariant(w.id);
    }
  }, 60_000);
});