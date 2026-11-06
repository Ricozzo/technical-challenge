import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PENDING_REFERENCE_POLICY } from "../../src/application/pending-reference-policy";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../src/application/use-cases/process-wager-transaction";
import {
  type PendingReferenceEvaluator,
  RetryPendingReferencesUseCase,
} from "../../src/application/use-cases/retry-pending-references";
import { FailureCode } from "../../src/domain/wager/failure-code";
import { WagerTransactionStatus as Status } from "../../src/domain/wager/wager-transaction-status";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";
import { PendingReferenceWorker } from "../../src/interfaces/workers/pending-reference.worker";
import { createTestContext, type TestContext } from "../helpers/test-database";

const logger = new JsonLogger({}, () => {});
const metrics = new MetricsRegistry();

// Relógio controlado: os testes avançam o tempo em vez de esperar o backoff de verdade.
let clock = new Date();
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

let ctx: TestContext;
let openWallet: OpenWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  ctx = await createTestContext();
  openWallet = new OpenWalletUseCase({ uow: ctx.uow, now });
  processTx = new ProcessWagerTransactionUseCase({ uow: ctx.uow, now });
});
beforeEach(async () => {
  clock = new Date();
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

// Helpers

function makeRetry(evaluator: PendingReferenceEvaluator = processTx, batchSize = 20) {
  return new RetryPendingReferencesUseCase({ uow: ctx.uow, evaluator, logger, metrics, batchSize, now });
}

type W = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: "BRL" });

let walletSeq = 0;
async function newWallet(balance = "100.00"): Promise<W> {
  const r = await openWallet.execute({
    playerId: `pending-player-${++walletSeq}`,
    initialBalance: brl(balance),
  });
  return { id: r.id, playerId: r.playerId };
}

function command(
  w: W,
  over: Partial<ProcessWagerTransactionCommand> & { externalTransactionId: string },
): ProcessWagerTransactionCommand {
  return {
    idempotencyKey: `provider-a:${over.externalTransactionId}`,
    providerId: "provider-a",
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: brl("25.00"),
    ...over,
  };
}

const refund = (w: W, ext: string, ref: string, amount = "25.00") =>
  command(w, { externalTransactionId: ext, kind: "REFUND", referenceExternalTransactionId: ref, money: brl(amount) });

const rollback = (w: W, ext: string, ref: string, amount = "25.00") =>
  command(w, { externalTransactionId: ext, kind: "ROLLBACK", referenceExternalTransactionId: ref, money: brl(amount) });

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await ctx.orm.em.execute(sql, params)) as unknown as T[];
}

async function walletBalance(id: string): Promise<string | undefined> {
  const [row] = await rows<{ balance: string }>("select balance::text as balance from wallets where id = ?", [id]);
  return row?.balance;
}

async function creditCount(walletId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT'",
    [walletId],
  );
  return row?.n ?? 0;
}

async function txRow(ext: string) {
  const [r] = await rows<{
    id: string;
    status: string;
    failure_code: string | null;
    attempts: number;
    next_attempt_at: string | Date | null;
    reference_transaction_id: string | null;
    resulting_balance: string | null;
  }>(
    `select id, status, failure_code, attempts, next_attempt_at, reference_transaction_id,
            resulting_balance::text as resulting_balance
       from wager_transactions where external_transaction_id = ?`,
    [ext],
  );
  if (!r) throw new Error(`transaction ${ext} not found`);
  return {
    ...r,
    attempts: Number(r.attempts),
    next_attempt_at: r.next_attempt_at === null ? null : new Date(r.next_attempt_at),
  };
}

async function expectInvariant(walletId: string) {
  const wallet = await ctx.uow.run((r) => r.wallets.findById(walletId));
  const rebuilt = await ctx.uow.run((r) => r.ledger.reconstructBalance(walletId, "BRL"));
  expect(rebuilt.balance.equals(wallet!.balance)).toBe(true);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("waitFor timed out");
}

// A referência chega depois

describe("a referência chega depois", () => {
  test("REFUND antes da BET: fica pendente e é aplicado quando a BET chega", async () => {
    const w = await newWallet("100.00");

    const pending = await processTx.execute(refund(w, "refund-1", "bet-1"));
    expect(pending.status).toBe(Status.PendingReference);
    expect(await walletBalance(w.id)).toBe("100.00");

    advance(1_000);
    expect((await makeRetry().execute()).due).toBe(0);

    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    expect(await walletBalance(w.id)).toBe("75.00");

    advance(2_000);
    const result = await makeRetry().execute();
    expect(result).toMatchObject({ due: 1, processed: 1, rejected: 0, waiting: 0 });

    expect(await walletBalance(w.id)).toBe("100.00");
    const row = await txRow("refund-1");
    const bet = await txRow("bet-1");
    expect(row.status).toBe(Status.Processed);
    expect(row.reference_transaction_id).toBe(bet.id);
    expect(row.attempts).toBe(1);
    expect(row.resulting_balance).toBe("100.00");

    await expectInvariant(w.id);
    expect(await ctx.eventTypes()).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);

    const replay = await processTx.execute(refund(w, "refund-1", "bet-1"));
    expect(replay).toMatchObject({ status: Status.Processed, idempotentReplay: true });
    expect(replay.balance?.toJSON().amount).toBe("100.00");

    expect(metrics.render()).toContain("pending_reference_retries_total");
  });

  test("ROLLBACK antes da WIN: depois da espera, debita o valor da WIN", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(rollback(w, "rb-1", "win-1", "50.00"));
    await processTx.execute(command(w, { externalTransactionId: "win-1", kind: "WIN", money: brl("50.00") }));
    expect(await walletBalance(w.id)).toBe("150.00");

    advance(2_000);
    await makeRetry().execute();

    expect(await walletBalance(w.id)).toBe("100.00");
    expect((await txRow("rb-1")).status).toBe(Status.Processed);
    await expectInvariant(w.id);
  });

  test("se, depois da espera, a reversão deixaria saldo negativo: REJECTED com código próprio", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(rollback(w, "rb-1", "win-1", "50.00")); // pendente
    await processTx.execute(command(w, { externalTransactionId: "win-1", kind: "WIN", money: brl("50.00") })); // 150
    await processTx.execute(command(w, { externalTransactionId: "bet-1", money: brl("140.00") })); // 10

    advance(2_000);
    const result = await makeRetry().execute();

    expect(result).toMatchObject({ processed: 0, rejected: 1 });
    const row = await txRow("rb-1");
    expect(row.status).toBe(Status.Rejected);
    expect(row.failure_code).toBe(FailureCode.ReversalWouldOverdraw);
    expect(await walletBalance(w.id)).toBe("10.00");
    expect(await ctx.eventTypes()).toContain("WagerTransactionRejected");
    await expectInvariant(w.id);
  });
});

// A referência nunca chega

describe("a referência nunca chega", () => {
  test("backoff exponencial e, no fim, REJECTED com REFERENCE_NOT_FOUND e evento", async () => {
    const w = await newWallet("100.00");
    const startedAt = clock;
    await processTx.execute(refund(w, "refund-1", "bet-que-nunca-chega"));

    const delays: number[] = [];
    for (let attempt = 1; attempt < PENDING_REFERENCE_POLICY.maxAttempts; attempt++) {
      const before = await txRow("refund-1");
      clock = before.next_attempt_at!; // avança até o instante exato da próxima tentativa
      expect(await makeRetry().execute()).toMatchObject({ due: 1, waiting: 1 });

      const after = await txRow("refund-1");
      expect(after.status).toBe(Status.PendingReference);
      expect(after.attempts).toBe(attempt);
      delays.push(after.next_attempt_at!.getTime() - clock.getTime());
    }
    expect(delays).toEqual([4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);

    // Última tentativa: o limite foi atingido.
    clock = (await txRow("refund-1")).next_attempt_at!;
    expect(await makeRetry().execute()).toMatchObject({ due: 1, expired: 1 });

    const row = await txRow("refund-1");
    expect(row.status).toBe(Status.Rejected);
    expect(row.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(row.attempts).toBe(PENDING_REFERENCE_POLICY.maxAttempts);
    expect(clock.getTime() - startedAt.getTime()).toBe(242_000);

    expect(await ctx.eventTypes()).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
      "WalletBalanceChanged",
    ]);
    expect(await walletBalance(w.id)).toBe("100.00");

    const replay = await processTx.execute(refund(w, "refund-1", "bet-que-nunca-chega"));
    expect(replay).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      idempotentReplay: true,
    });

    await processTx.execute(command(w, { externalTransactionId: "bet-que-nunca-chega" }));
    expect(await makeRetry().execute()).toMatchObject({ due: 0 });
    expect((await txRow("refund-1")).status).toBe(Status.Rejected);
    expect(await walletBalance(w.id)).toBe("75.00");
    await expectInvariant(w.id);
  });
});

// Várias instâncias

describe("várias instâncias", () => {
  test("três workers sobre a mesma transação vencida: a reversão é aplicada uma única vez", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(refund(w, "refund-1", "bet-1"));
    await processTx.execute(command(w, { externalTransactionId: "bet-1" })); // 75.00
    advance(2_000);

    const results = await Promise.all([makeRetry().execute(), makeRetry().execute(), makeRetry().execute()]);

    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(1);
    expect(await walletBalance(w.id)).toBe("100.00");
    expect(await creditCount(w.id)).toBe(2);
    expect((await txRow("refund-1")).attempts).toBe(1);
    await expectInvariant(w.id);
  }, 30_000);

  test("três workers: a mesma tentativa não é contada duas vezes", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(refund(w, "refund-1", "bet-que-nao-chegou"));
    advance(2_000);

    const results = await Promise.all([makeRetry().execute(), makeRetry().execute(), makeRetry().execute()]);

    expect(results.reduce((n, r) => n + r.waiting, 0)).toBe(1);
    expect((await txRow("refund-1")).attempts).toBe(1);
  }, 30_000);

  test("várias wallets pendentes ao mesmo tempo são resolvidas em paralelo", async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => newWallet("100.00")));
    for (const [i, w] of wallets.entries()) {
      await processTx.execute(refund(w, `refund-${i}`, `bet-${i}`));
      await processTx.execute(command(w, { externalTransactionId: `bet-${i}` }));
    }
    advance(2_000);

    const results = await Promise.all([makeRetry().execute(), makeRetry().execute(), makeRetry().execute()]);

    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(6);
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe("100.00");
      await expectInvariant(w.id);
    }
  }, 60_000);
});

// Falhas

describe("falhas", () => {
  const poisoned = (externalId: string): PendingReferenceEvaluator => ({
    reevaluatePendingReference: (repos, stored, wallet, at) =>
      stored.transaction.externalTransactionId === externalId
        ? Promise.reject(new Error("boom"))
        : processTx.reevaluatePendingReference(repos, stored, wallet, at),
  });

  test("uma transação que quebra não trava as outras, é adiada com backoff e acaba em FAILED", async () => {
    const poison = await newWallet("100.00");
    const healthy = await newWallet("100.00");
    await processTx.execute(refund(poison, "refund-poison", "bet-poison"));
    await processTx.execute(refund(healthy, "refund-ok", "bet-ok"));
    await processTx.execute(command(healthy, { externalTransactionId: "bet-ok" }));
    advance(2_000);

    const retry = makeRetry(poisoned("refund-poison"));
    expect(await retry.execute()).toMatchObject({ due: 2, errors: 1, processed: 1 });
    expect((await txRow("refund-ok")).status).toBe(Status.Processed);

    const afterFirst = await txRow("refund-poison");
    expect(afterFirst.status).toBe(Status.PendingReference);
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.next_attempt_at!.getTime()).toBeGreaterThan(clock.getTime());

    for (let i = 0; i < 10 && (await txRow("refund-poison")).status === Status.PendingReference; i++) {
      clock = (await txRow("refund-poison")).next_attempt_at!;
      await retry.execute();
    }

    const final = await txRow("refund-poison");
    expect(final.status).toBe(Status.Failed);
    expect(final.failure_code).toBe(FailureCode.InternalError);
    expect(final.attempts).toBe(PENDING_REFERENCE_POLICY.maxAttempts);
    expect(await walletBalance(poison.id)).toBe("100.00");
    await expectInvariant(poison.id);
  }, 30_000);
});

// Worker

describe("worker", () => {
  test("aplica a reversão sozinho quando a referência aparece", async () => {
    const w = await newWallet("100.00");
    await processTx.execute(refund(w, "refund-1", "bet-1"));
    await processTx.execute(command(w, { externalTransactionId: "bet-1" }));
    advance(5_000);

    const worker = new PendingReferenceWorker({ useCase: makeRetry(), logger, idleDelayMs: 20 });
    worker.start();
    await waitFor(async () => (await txRow("refund-1")).status === Status.Processed);
    await worker.stop();

    expect(await walletBalance(w.id)).toBe("100.00");
    await expectInvariant(w.id);
  }, 30_000);

  test("stop() pode ser chamado mais de uma vez", async () => {
    const worker = new PendingReferenceWorker({ useCase: makeRetry(), logger, idleDelayMs: 20 });
    worker.start();
    await worker.stop();
    await worker.stop();
  });
});