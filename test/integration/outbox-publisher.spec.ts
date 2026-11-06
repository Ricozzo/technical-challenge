import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../src/application/ports/event-publisher";
import type { Repositories, UnitOfWork } from "../../src/application/ports/repositories";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { OutboxPublisherWorker } from "../../src/infrastructure/messaging/outbox-publisher.worker";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";
import { createTestContext, type TestContext } from "../helpers/test-database";

let ctx: TestContext;
const logger = new JsonLogger({}, () => {});
const metrics = new MetricsRegistry();

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

// Helpers

class RecordingPublisher implements EventPublisher {
  readonly calls: string[] = [];
  started = 0;
  failing = false;

  constructor(private readonly delayMs = 0) {}

  async publish(message: OutboxMessage): Promise<void> {
    this.started++;
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    if (this.failing) throw new Error("sqs unavailable");
    this.calls.push(message.id);
  }
}

/** Simula um crash depois de publicar e antes do commit: a transação inteira é desfeita. */
class CrashBeforeCommit implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repos) => {
      await work(repos);
      throw new Error("crash before commit");
    });
  }
}

function makeUseCase(
  publisher: EventPublisher,
  over: { uow?: UnitOfWork; now?: () => Date; batchSize?: number } = {},
) {
  return new PublishOutboxUseCase({
    uow: over.uow ?? ctx.uow,
    publisher,
    logger,
    metrics,
    batchSize: over.batchSize ?? 10,
    ...(over.now && { now: over.now }),
  });
}

const base = Date.now();

async function seed(count: number, aggregates = 5): Promise<string[]> {
  const ids: string[] = [];
  await ctx.uow.run(async (repos) => {
    for (let i = 0; i < count; i++) {
      const message = OutboxMessage.rehydrate({
        id: Bun.randomUUIDv7(),
        aggregateId: `wallet-${i % aggregates}`,
        eventType: "TestEvent",
        payload: { n: i },
        occurredAt: new Date(base + i),
        attempts: 0,
      });
      ids.push(message.id);
      await repos.outbox.add(message);
    }
  });
  return ids;
}

async function pendingCount(): Promise<number> {
  const rows = (await ctx.orm.em.execute(
    "select count(*)::int as n from outbox_messages where published_at is null",
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function outboxRows() {
  const rows = (await ctx.orm.em.execute(
    "select id, attempts, next_attempt_at, published_at, last_error from outbox_messages order by occurred_at",
  )) as unknown as Array<{
    id: string;
    attempts: number;
    next_attempt_at: string | Date | null;
    published_at: string | Date | null;
    last_error: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    attempts: Number(r.attempts),
    next_attempt_at: r.next_attempt_at === null ? null : new Date(r.next_attempt_at),
    published_at: r.published_at === null ? null : new Date(r.published_at),
    last_error: r.last_error,
  }));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("waitFor timed out");
}

// SQS de verdade

describe("publicação no SQS real", () => {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
  const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1", endpoint });
  const queueName = `test-events-${Bun.randomUUIDv7()}.fifo`;
  const queueUrl = `${endpoint}/000000000000/${queueName}`;

  beforeAll(async () => {
    await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
  });
  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
    sqs.destroy();
  });

  async function receive(expected: number, timeoutMs = 15_000) {
    const received: Array<{ body: Record<string, any>; groupId?: string; eventType?: string }> = [];
    const deadline = Date.now() + timeoutMs;
    while (received.length < expected && Date.now() < deadline) {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          AttributeNames: ["All"],
          MessageAttributeNames: ["All"],
        }),
      );
      for (const m of res.Messages ?? []) {
        received.push({
          body: JSON.parse(m.Body ?? "{}"),
          groupId: m.Attributes?.MessageGroupId,
          eventType: m.MessageAttributes?.eventType?.StringValue,
        });
      }
    }
    return received;
  }

  test("os eventos de uma aposta chegam ao SQS com o envelope, o grupo e o tipo corretos", async () => {
    const opened = await new OpenWalletUseCase({ uow: ctx.uow }).execute({
      playerId: "player-sqs",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await new ProcessWagerTransactionUseCase({ uow: ctx.uow }).execute({
      idempotencyKey: "provider-a:sqs-1",
      providerId: "provider-a",
      externalTransactionId: "sqs-1",
      playerId: "player-sqs",
      walletId: opened.id,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    expect(await pendingCount()).toBe(3);

    const useCase = makeUseCase(new SqsEventPublisher(sqs, queueUrl));
    const result = await useCase.execute();
    expect(result).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(await pendingCount()).toBe(0);

    const received = await receive(3);
    expect(received).toHaveLength(3);

    const expectedIds = (await outboxRows()).map((r) => r.id).sort();
    expect(received.map((m) => m.body.eventId).sort()).toEqual(expectedIds);
    expect(received.every((m) => m.groupId === opened.id)).toBe(true);

    const types = received.map((m) => m.eventType).sort();
    expect(types).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged", "WalletBalanceChanged"]);
    for (const m of received) expect(m.body.eventType).toBe(m.eventType);

    const debit = received.find(
      (m) => m.eventType === "WalletBalanceChanged" && m.body.data.direction === "DEBIT",
    );
    expect(debit?.body.data.balanceAfter).toEqual({ amount: "75.00", currency: "BRL" });
    expect(typeof debit?.body.data.money.amount).toBe("string");

    expect((await useCase.execute()).claimed).toBe(0);
    expect(await metrics.render()).toContain("outbox_events_published_total");
  }, 30_000);
});

// Falhas

describe("falha na publicação", () => {
  test("agenda a nova tentativa com backoff, guarda o erro e não perde o evento", async () => {
    await seed(1);
    const publisher = new RecordingPublisher();
    publisher.failing = true;

    const first = await makeUseCase(publisher).execute();
    expect(first).toEqual({ claimed: 1, published: 0, failed: 1 });

    const [row] = await outboxRows();
    expect(row?.attempts).toBe(1);
    expect(row?.published_at).toBeNull();
    expect(row?.last_error).toContain("sqs unavailable");
    expect(row?.next_attempt_at).not.toBeNull();

    expect((await makeUseCase(publisher).execute()).claimed).toBe(0);

    publisher.failing = false;
    const later = makeUseCase(publisher, { now: () => new Date(Date.now() + 5_000) });
    expect(await later.execute()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await pendingCount()).toBe(0);
    expect(publisher.calls).toHaveLength(1);
  });

  test("o backoff cresce a cada falha", async () => {
    await seed(1);
    const publisher = new RecordingPublisher();
    publisher.failing = true;

    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.now() + 60 * 60 * 1000 * (i + 1));
      await makeUseCase(publisher, { now: () => at }).execute();
      const [row] = await outboxRows();
      delays.push((row?.next_attempt_at?.getTime() ?? 0) - at.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });
});

// Concorrência

describe("publishers concorrentes", () => {
  test("três publishers sobre a mesma outbox: cada evento é publicado exatamente uma vez", async () => {
    await seed(60);
    const publisher = new RecordingPublisher(10);

    const drain = async (): Promise<number> => {
      const useCase = makeUseCase(publisher);
      let total = 0;
      for (;;) {
        const result = await useCase.execute();
        if (result.claimed === 0) return total;
        total += result.published;
      }
    };
    const totals = await Promise.all([drain(), drain(), drain()]);

    expect(totals.reduce((a, b) => a + b, 0)).toBe(60);
    expect(publisher.calls).toHaveLength(60);
    expect(new Set(publisher.calls).size).toBe(60);
    expect(await pendingCount()).toBe(0);
    expect(totals.filter((t) => t > 0).length).toBeGreaterThan(1);
  }, 30_000);

  test("com um único publisher, os eventos saem na ordem em que ocorreram", async () => {
    const ids = await seed(25);
    const publisher = new RecordingPublisher();
    const useCase = makeUseCase(publisher);
    while ((await useCase.execute()).claimed > 0) {}
    expect(publisher.calls).toEqual(ids);
  });
});

// Crash recovery

describe("recuperação após crash", () => {
  test("o processo morre depois de publicar e antes do commit: outra instância assume, e a duplicata é segura", async () => {
    await seed(5);
    const publisher = new RecordingPublisher();

    const crashing = makeUseCase(publisher, { uow: new CrashBeforeCommit(ctx.uow) });
    await expect(crashing.execute()).rejects.toThrow("crash before commit");

    expect(publisher.calls).toHaveLength(5);
    expect(await pendingCount()).toBe(5);
    expect((await outboxRows()).every((r) => r.attempts === 0)).toBe(true);

    expect(await makeUseCase(publisher).execute()).toEqual({ claimed: 5, published: 5, failed: 0 });
    expect(await pendingCount()).toBe(0);

    expect(publisher.calls).toHaveLength(10);
    expect(new Set(publisher.calls).size).toBe(5);
  });

  test("a conexão com o banco cai com a linha travada: o lock é solto e outra instância assume", async () => {
    await seed(3);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed = 0;
    const holder = ctx.uow.run(async (repos) => {
      claimed = (await repos.outbox.claimDue(new Date(), 10)).length;
      await held;
      throw new Error("instance died");
    });
    holder.catch(() => {});
    await waitFor(() => claimed === 3);

    // Enquanto ela segura os locks, outra instância não pega nada e também não fica esperando.
    const publisher = new RecordingPublisher();
    expect((await makeUseCase(publisher).execute()).claimed).toBe(0);

    release();
    await expect(holder).rejects.toThrow("instance died");

    expect(await makeUseCase(publisher).execute()).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(await pendingCount()).toBe(0);
  });
});

// Worker

describe("worker", () => {
  test("publica os eventos que aparecem enquanto ele roda", async () => {
    const publisher = new RecordingPublisher();
    const worker = new OutboxPublisherWorker({ useCase: makeUseCase(publisher), logger, idleDelayMs: 20 });

    worker.start();
    await seed(5);
    await waitFor(async () => (await pendingCount()) === 0);
    await worker.stop();

    expect(publisher.calls).toHaveLength(5);
  });

  test("no encerramento, conclui a rodada em andamento antes de devolver", async () => {
    await seed(1);
    const publisher = new RecordingPublisher(300);
    const worker = new OutboxPublisherWorker({ useCase: makeUseCase(publisher), logger, idleDelayMs: 20 });

    worker.start();
    await waitFor(() => publisher.started === 1);
    await worker.stop();

    expect(publisher.calls).toHaveLength(1);
    expect(await pendingCount()).toBe(0);
  });

  test("stop() pode ser chamado mais de uma vez", async () => {
    const worker = new OutboxPublisherWorker({
      useCase: makeUseCase(new RecordingPublisher()),
      logger,
      idleDelayMs: 20,
    });
    worker.start();
    await worker.stop();
    await worker.stop();
  });
});