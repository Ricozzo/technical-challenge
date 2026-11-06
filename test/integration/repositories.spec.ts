import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Repositories } from "../../src/application/ports/repositories";
import { ConcurrentModificationError } from "../../src/application/errors";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WagerTransactionPendingReference } from "../../src/domain/messaging/wager-events";
import { Money } from "../../src/domain/money/money";
import { WagerTransaction } from "../../src/domain/wager/wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/domain/wager/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/domain/wager/wager-transaction-status";
import { Wallet } from "../../src/domain/wallet/wallet";
import { createTestContext, type TestContext } from "../helpers/test-database";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const uuid = () => Bun.randomUUIDv7();

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

const bet = (walletId: string, ext: string, amount = "30.00") =>
  WagerTransaction.create({
    id: uuid(),
    providerId: "provider-a",
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: "h",
    walletId,
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: Kind.Bet,
    money: brl(amount),
  });

/** Faz o que o caso de uso fará na abertura: wallet + OPENING + lançamento CREDIT. */
async function openWallet(repos: Repositories, amount: string, playerId = "p1"): Promise<Wallet> {
  const wallet = Wallet.open({ id: uuid(), playerId, initialBalance: brl(amount) });
  await repos.wallets.insertIfAbsent(wallet);

  const opening = WagerTransaction.createOpening({
    id: uuid(),
    walletId: wallet.id,
    playerId,
    money: brl(amount),
  });
  await repos.transactions.insertIfAbsent(opening);
  await repos.ledger.append(
    WalletLedgerEntry.create({
      id: uuid(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money: brl(amount),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: brl(amount),
      createdAt: new Date(),
    }),
  );
  opening.markProcessed(undefined, new Date());
  await repos.transactions.save(opening, { resultingBalance: wallet.balance });
  return wallet;
}

describe("wallets", () => {
  test("insere, lê de volta e recusa uma segunda wallet para o mesmo player e moeda", async () => {
    const id = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);

    const loaded = await ctx.uow.run((r) => r.wallets.findById(id));
    expect(loaded?.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(loaded?.version).toBe(1);

    const duplicate = Wallet.open({ id: uuid(), playerId: "p1", initialBalance: brl("5.00") });
    expect(await ctx.uow.run((r) => r.wallets.insertIfAbsent(duplicate))).toBe(false);
  });

  test("save com version desatualizada lança ConcurrentModificationError", async () => {
    const id = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);

    await ctx.uow.run(async (r) => {
      const a = (await r.wallets.findById(id))!;
      const b = (await r.wallets.findById(id))!;
      a.credit({ entryId: uuid(), transactionId: uuid(), money: brl("1.00"), at: new Date() });
      b.credit({ entryId: uuid(), transactionId: uuid(), money: brl("2.00"), at: new Date() });

      await r.wallets.save(a, 1); // a version no banco passa a 2
      await expect(r.wallets.save(b, 1)).rejects.toThrow(ConcurrentModificationError);
    });
  });
});

describe("transações", () => {
  test("a idempotência é persistente: a segunda inserção é recusada", async () => {
    const walletId = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);

    expect(await ctx.uow.run((r) => r.transactions.insertIfAbsent(bet(walletId, "ext-1")))).toBe(true);
    expect(await ctx.uow.run((r) => r.transactions.insertIfAbsent(bet(walletId, "ext-1")))).toBe(false);

    const byKey = await ctx.uow.run((r) => r.transactions.findByIdempotencyKey("provider-a", "provider-a:ext-1"));
    const byExternal = await ctx.uow.run((r) => r.transactions.findByExternalId("provider-a", "ext-1"));
    expect(byKey?.transaction.status).toBe(Status.Pending);
    expect(byExternal?.transaction.id).toBe(byKey?.transaction.id);
  });

  test("20 inserções paralelas da mesma chave: exatamente uma vence", async () => {
    const walletId = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.uow.run((r) => r.transactions.insertIfAbsent(bet(walletId, "ext-race"))),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ctx.count("wager_transactions")).toBe(2); // OPENING + a aposta
  });

  test("save grava o resultado e guarda o saldo observado", async () => {
    const walletId = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);
    const tx = bet(walletId, "ext-1");
    await ctx.uow.run((r) => r.transactions.insertIfAbsent(tx));

    tx.markProcessed(undefined, new Date());
    await ctx.uow.run((r) => r.transactions.save(tx, { resultingBalance: brl("70.00") }));

    const stored = await ctx.uow.run((r) => r.transactions.findById(tx.id));
    expect(stored?.transaction.status).toBe(Status.Processed);
    expect(stored?.resultingBalance?.toJSON().amount).toBe("70.00");
  });
});

describe("ledger", () => {
  test("o saldo da wallet é igual ao saldo reconstruído pelo ledger", async () => {
    const walletId = await ctx.uow.run(async (r) => (await openWallet(r, "100.00")).id);

    await ctx.uow.run(async (r) => {
      const tx = bet(walletId, "ext-1", "30.00");
      await r.transactions.insertIfAbsent(tx);

      const wallet = (await r.wallets.findByIdForUpdate(walletId))!;
      const expectedVersion = wallet.version;
      const entry = wallet.debit({
        entryId: uuid(),
        transactionId: tx.id,
        money: tx.money,
        at: new Date(),
      });
      await r.ledger.append(entry);
      await r.wallets.save(wallet, expectedVersion);

      tx.markProcessed(undefined, new Date());
      await r.transactions.save(tx, { resultingBalance: wallet.balance });
    });

    const wallet = await ctx.uow.run((r) => r.wallets.findById(walletId));
    const rebuilt = await ctx.uow.run((r) => r.ledger.reconstructBalance(walletId, "BRL"));

    expect(wallet?.balance.toJSON().amount).toBe("70.00");
    expect(rebuilt.balance.equals(wallet!.balance)).toBe(true);
    expect(rebuilt.entries).toBe(2);
  });
});

describe("atomicidade da unidade de trabalho", () => {
  const sampleOutbox = (walletId: string) => {
    const refund = WagerTransaction.create({
      id: uuid(),
      providerId: "provider-a",
      externalTransactionId: "ext-2",
      idempotencyKey: "provider-a:ext-2",
      payloadHash: "h",
      walletId,
      playerId: "p1",
      roundId: "r1",
      gameId: "g1",
      kind: Kind.Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "ext-1",
    });
    return OutboxMessage.enqueue(
      WagerTransactionPendingReference.from(refund, {
        eventId: uuid(),
        correlationId: uuid(),
        occurredAt: new Date(),
      }),
    );
  };

  test("se algo falha, nada é gravado: nem wallet, nem outbox", async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: "p9", initialBalance: brl("10.00") });

    await expect(
      ctx.uow.run(async (r) => {
        await r.wallets.insertIfAbsent(wallet);
        await r.outbox.add(sampleOutbox(wallet.id));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await ctx.count("wallets")).toBe(0);
    expect(await ctx.count("outbox_messages")).toBe(0);
  });

  test("se tudo funciona, tudo é confirmado junto", async () => {
    const wallet = Wallet.open({ id: uuid(), playerId: "p9", initialBalance: brl("10.00") });

    await ctx.uow.run(async (r) => {
      await r.wallets.insertIfAbsent(wallet);
      await r.outbox.add(sampleOutbox(wallet.id));
    });

    expect(await ctx.count("wallets")).toBe(1);
    expect(await ctx.count("outbox_messages")).toBe(1);
  });
});

describe("inbox", () => {
  test("deduplica por (consumerName, messageId) e guarda o processamento", async () => {
    const message = InboxMessage.receive({ messageId: "m1", consumerName: "wager-consumer", payloadHash: "h" });

    expect(await ctx.uow.run((r) => r.inbox.receive(message))).toBe(true);
    expect(await ctx.uow.run((r) => r.inbox.receive(message))).toBe(false);

    message.markProcessed(new Date());
    await ctx.uow.run((r) => r.inbox.markProcessed(message));

    const stored = await ctx.uow.run((r) => r.inbox.find("wager-consumer", "m1"));
    expect(stored?.isProcessed()).toBe(true);
    expect(stored?.matchesPayload("h")).toBe(true);
  });
});