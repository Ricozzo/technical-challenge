import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
} from "../../src/application/errors";
import type { EventPublisher } from "../../src/application/ports/event-publisher";
import type { UnitOfWork } from "../../src/application/ports/repositories";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../src/application/use-cases/process-wager-transaction";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox";
import { ReportOutboxStatsUseCase } from "../../src/application/use-cases/report-outbox-stats";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";
import { createTestContext, type TestContext } from "../helpers/test-database";

let ctx: TestContext;
let metrics: MetricsRegistry;
let logger: JsonLogger;
let lines: string[];
let processTx: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  metrics = new MetricsRegistry();
  lines = [];
  logger = new JsonLogger({}, (line) => {
    lines.push(line);
  }, "debug");
  processTx = new ProcessWagerTransactionUseCase({ uow: ctx.uow, logger, metrics });
});
afterAll(async () => {
  await ctx.close();
});

// Helpers

type W = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: "BRL" });

let seq = 0;
async function newWallet(balance = "100.00", playerId = `obs-player-${++seq}`): Promise<W> {
  const r = await new OpenWalletUseCase({ uow: ctx.uow }).execute({
    playerId,
    initialBalance: brl(balance),
  });
  return { id: r.id, playerId: r.playerId };
}

function command(w: W, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  const ext = over.externalTransactionId ?? `ext-${++seq}`;
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

const parsedLines = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

// Transações

describe("transações por status", () => {
  test("conta por tipo, status e origem, e mede a latência", async () => {
    const w = await newWallet("30.00");
    await processTx.execute(command(w));
    await processTx.execute(command(w));
    await processTx.execute(
      command(w, { kind: "REFUND", referenceExternalTransactionId: "bet-que-nao-chegou" }),
    ); // PENDING_REFERENCE
    await processTx.execute(
      command(w, { money: brl("1.00"), inbox: { consumerName: "c1", messageId: "m1" } }),
    ); // PROCESSED, vindo do SQS

    const count = (status: string, source = "http", kind = "BET") =>
      metrics.valueOf("wager_transactions_total", { kind, status, source });

    expect(count("PROCESSED")).toBe(1);
    expect(count("REJECTED")).toBe(1);
    expect(count("PENDING_REFERENCE", "http", "REFUND")).toBe(1);
    expect(count("PROCESSED", "sqs")).toBe(1);
    expect(
      metrics.histogram("wager_processing_duration_seconds", { source: "http", outcome: "processed" })?.count,
    ).toBe(1);
  }, 30_000);
});

// Duplicatas

describe("duplicatas e conflitos de idempotência", () => {
  test("são contadas por origem e não viram uma nova transação", async () => {
    const w = await newWallet("100.00");
    const viaHttp = command(w);
    await processTx.execute(viaHttp);
    await processTx.execute(viaHttp);

    const viaSqs = command(w, { inbox: { consumerName: "c1", messageId: "m1" } });
    await processTx.execute(viaSqs);
    await processTx.execute(viaSqs);

    expect(metrics.valueOf("duplicates_detected_total", { source: "http" })).toBe(1);
    expect(metrics.valueOf("duplicates_detected_total", { source: "sqs" })).toBe(1);
    expect(
      metrics.valueOf("wager_transactions_total", { kind: "BET", status: "PROCESSED", source: "http" }),
    ).toBe(1);
    expect(
      metrics.valueOf("wager_transactions_total", { kind: "BET", status: "PROCESSED", source: "sqs" }),
    ).toBe(1);
  }, 30_000);

  test("o conflito é contado, logado sem o payload e entra como erro na latência", async () => {
    const w = await newWallet("100.00");
    const original = command(w, { externalTransactionId: "ext-conflict" });
    await processTx.execute(original);

    await expect(processTx.execute({ ...original, money: brl("99.00") })).rejects.toThrow(
      IdempotencyConflictError,
    );

    expect(metrics.valueOf("idempotency_conflicts_total", { source: "http" })).toBe(1);
    expect(metrics.histogram("wager_processing_duration_seconds", { source: "http", outcome: "error" })?.count).toBe(1);

    const conflict = parsedLines().find((e) => e.msg === "idempotency_conflict");
    expect(conflict).toMatchObject({ level: "warn", walletId: w.id, providerId: "provider-a" });
    expect(lines.join("\n")).not.toContain("99.00");
  }, 30_000);
});

// Lock

describe("lock", () => {
  test("a espera pelo lock da wallet é medida: wallet quente com 20 apostas simultâneas", async () => {
    const w = await newWallet("1000.00");
    await Promise.all(
      Array.from({ length: 20 }, () => processTx.execute(command(w, { money: brl("1.00") }))),
    );

    const wait = metrics.histogram("wallet_lock_wait_seconds");
    expect(wait?.count).toBe(20);
    expect(wait?.sum ?? 0).toBeGreaterThan(0);
  }, 30_000);

  const failingUow = (error: Error): UnitOfWork => ({ run: () => Promise.reject(error) });

  const conflicts: Array<[string, Error]> = [
    ["version_mismatch", new ConcurrentModificationError("stale version")],
    ["deadlock", Object.assign(new Error("deadlock detected"), { code: "40P01" })],
    ["serialization_failure", Object.assign(new Error("could not serialize"), { code: "40001" })],
    ["lock_timeout", Object.assign(new Error("lock not available"), { code: "55P03" })],
  ];

  test.each(conflicts)("o conflito %s é contado e logado", async (reason, error) => {
    const useCase = new ProcessWagerTransactionUseCase({ uow: failingUow(error), logger, metrics });
    const ghost = { id: Bun.randomUUIDv7(), playerId: "ghost" };

    await expect(useCase.execute(command(ghost))).rejects.toThrow();

    expect(metrics.valueOf("lock_conflicts_total", { reason })).toBe(1);
    const logged = parsedLines().find((e) => e.msg === "wallet_lock_conflict");
    expect(logged).toMatchObject({ level: "warn", reason, walletId: ghost.id });
  });
});

// Outbox lag

describe("outbox lag", () => {
  test("gauges de pendentes e de idade, e a distribuição do lag na publicação", async () => {
    const base = Date.now();
    const now = () => new Date(base);

    await ctx.uow.run(async (repos) => {
      for (const ageMs of [90_000, 30_000, 10_000]) {
        await repos.outbox.add(
          OutboxMessage.rehydrate({
            id: Bun.randomUUIDv7(),
            aggregateId: "wallet-1",
            eventType: "TestEvent",
            payload: {},
            occurredAt: new Date(base - ageMs),
            attempts: 0,
          }),
        );
      }
    });

    const report = new ReportOutboxStatsUseCase({ uow: ctx.uow, metrics, now });
    const before = await report.execute();
    expect(before.pending).toBe(3);
    expect(before.oldestAgeSeconds).toBeCloseTo(90, 0);
    expect(metrics.valueOf("outbox_pending_events")).toBe(3);
    expect(metrics.valueOf("outbox_oldest_pending_age_seconds")).toBeCloseTo(90, 0);

    const publisher: EventPublisher = { publish: async () => {} };
    const publish = new PublishOutboxUseCase({ uow: ctx.uow, publisher, logger, metrics, batchSize: 10, now });
    expect(await publish.execute()).toEqual({ claimed: 3, published: 3, failed: 0 });

    const lag = metrics.histogram("outbox_publish_lag_seconds", { event_type: "TestEvent" });
    expect(lag?.count).toBe(3);
    expect(lag?.sum).toBeCloseTo(130, 0); // 90 + 30 + 10

    expect(await report.execute()).toEqual({ pending: 0, oldestAgeSeconds: 0 });
    expect(metrics.valueOf("outbox_pending_events")).toBe(0);
  }, 30_000);
});

// Logs

describe("logs", () => {
  test("trazem os campos de correlação e nenhum dado sensível", async () => {
    const w = await newWallet("100.00", "player-pii-123");
    await processTx.execute(
      command(w, {
        externalTransactionId: "ext-log",
        correlationId: "corr-1",
        inbox: { consumerName: "wager-consumer", messageId: "msg-1" },
      }),
    );

    const decided = parsedLines().find((e) => e.msg === "transaction_decided");
    expect(decided).toMatchObject({
      level: "info",
      correlationId: "corr-1",
      messageId: "msg-1",
      walletId: w.id,
      providerId: "provider-a",
      kind: "BET",
      status: "PROCESSED",
      source: "sqs",
      idempotentReplay: false,
    });
    expect(typeof decided?.transactionId).toBe("string");
    expect(typeof decided?.ts).toBe("string");

    const all = lines.join("\n");
    for (const secret of ["25.00", "player-pii-123", "ext-log", "provider-a:ext-log", "balance"]) {
      expect(all).not.toContain(secret);
    }
  }, 30_000);
});