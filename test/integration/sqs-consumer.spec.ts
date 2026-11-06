import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { OpenWalletUseCase } from "../../src/application/use-cases/open-wallet";
import {
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from "../../src/application/use-cases/process-wager-transaction";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";
import {
  type WagerConsumerOptions,
  type WagerMessageProcessor,
  WagerQueueConsumer,
} from "../../src/interfaces/sqs/wager-consumer";
import { createTestContext, type TestContext } from "../helpers/test-database";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1", endpoint });
const logger = new JsonLogger({}, () => {});
const metrics = new MetricsRegistry();

let ctx: TestContext;
let realProcessor: ProcessWagerTransactionUseCase;
let q: { main: string; dlq: string };
const consumers: WagerQueueConsumer[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  realProcessor = new ProcessWagerTransactionUseCase({ uow: ctx.uow });
});
beforeEach(async () => {
  await ctx.reset();
  q = await createQueues();
});
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
  await Promise.all([q.main, q.dlq].map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {})));
});
afterAll(async () => {
  await ctx.close();
  sqs.destroy();
});

// Helpers

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const res = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!res.QueueUrl) throw new Error(`Queue ${name} was not created`);
  return res.QueueUrl;
}

async function createQueues() {
  const suffix = Bun.randomUUIDv7().slice(-12);
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
  const dlq = await createQueue(`test-wager-dlq-${suffix}.fifo`, fifo);
  const main = await createQueue(`test-wager-${suffix}.fifo`, { ...fifo, VisibilityTimeout: "2" });
  return { main, dlq };
}

async function depth(url: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ],
    }),
  );
  const a = res.Attributes ?? {};
  return (
    Number(a.ApproximateNumberOfMessages ?? 0) +
    Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(a.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

async function readDlq(expected: number, timeoutMs = 15_000) {
  const out: Array<{ body: string; attrs: Record<string, string> }> = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < expected && Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: q.dlq,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    for (const m of res.Messages ?? []) {
      const attrs: Record<string, string> = {};
      for (const [key, value] of Object.entries(m.MessageAttributes ?? {})) {
        attrs[key] = value.StringValue ?? "";
      }
      out.push({ body: m.Body ?? "", attrs });
    }
  }
  return out;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await ctx.orm.em.execute(sql, params)) as unknown as T[];
}

async function walletBalance(id: string): Promise<string | undefined> {
  const [row] = await rows<{ balance: string }>("select balance::text as balance from wallets where id = ?", [id]);
  return row?.balance;
}

async function debitCount(walletId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
    [walletId],
  );
  return row?.n ?? 0;
}

async function inboxCount(): Promise<number> {
  const [row] = await rows<{ n: number }>("select count(*)::int as n from inbox_messages");
  return row?.n ?? 0;
}

async function expectInvariant(walletId: string) {
  const wallet = await ctx.uow.run((r) => r.wallets.findById(walletId));
  const rebuilt = await ctx.uow.run((r) => r.ledger.reconstructBalance(walletId, "BRL"));
  expect(rebuilt.balance.equals(wallet!.balance)).toBe(true);
}

type W = { id: string; playerId: string };

let walletSeq = 0;
async function newWallet(balance = "100.00"): Promise<W> {
  const r = await new OpenWalletUseCase({ uow: ctx.uow }).execute({
    playerId: `consumer-player-${++walletSeq}`,
    initialBalance: { amount: balance, currency: "BRL" },
  });
  return { id: r.id, playerId: r.playerId };
}

let extSeq = 0;
function wagerMessage(
  w: W,
  o: { messageId?: string; ext?: string; kind?: string; amount?: string; data?: Record<string, unknown> } = {},
) {
  const ext = o.ext ?? `ext-${++extSeq}`;
  return {
    messageId: o.messageId ?? `msg-${Bun.randomUUIDv7()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId: w.playerId,
      walletId: w.id,
      roundId: "round-1",
      gameId: "game-1",
      kind: o.kind ?? "BET",
      money: { amount: o.amount ?? "25.00", currency: "BRL" },
      ...o.data,
    },
  };
}

async function enqueue(body: unknown, opts: { group: string; dedup?: string }): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: q.main,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: opts.group,
      MessageDeduplicationId: opts.dedup ?? Bun.randomUUIDv7(),
    }),
  );
}

class ProbeProcessor implements WagerMessageProcessor {
  started = 0;
  completed = 0;

  constructor(
    private readonly inner: WagerMessageProcessor,
    private readonly opts: { delayMs?: number; failFirst?: number; failAlways?: boolean } = {},
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    this.started++;
    if (this.opts.delayMs) await Bun.sleep(this.opts.delayMs);
    if (this.opts.failAlways || this.started <= (this.opts.failFirst ?? 0)) {
      throw Object.assign(new Error("database unavailable"), { code: "ECONNRESET" });
    }
    const result = await this.inner.execute(command);
    this.completed++;
    return result;
  }
}

/** Simula o worker morrendo depois do commit e antes do ack: os primeiros DeleteMessage falham. */
function flakyAck(client: SQSClient, failures: number): SQSClient {
  let failed = 0;
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "send") {
        return (command: unknown, ...rest: unknown[]) => {
          if (command instanceof DeleteMessageCommand && failed < failures) {
            failed++;
            return Promise.reject(new Error("worker died before the ack"));
          }
          return Reflect.apply(target.send, target, [command, ...rest]);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeConsumer(
  processor: WagerMessageProcessor,
  over: Partial<WagerConsumerOptions> = {},
  client: SQSClient = sqs,
): WagerQueueConsumer {
  const consumer = new WagerQueueConsumer({
    sqs: client,
    queueUrl: q.main,
    dlqUrl: q.dlq,
    processor,
    logger,
    metrics,
    maxAttempts: 3,
    waitTimeSeconds: 1,
    retryBaseDelaySeconds: 1,
    retryMaxDelaySeconds: 2,
    errorDelayMs: 200,
    ...over,
  });
  consumers.push(consumer);
  return consumer;
}

// Caminho feliz

describe("processamento", () => {
  test("debita, grava a inbox e a outbox, e só então faz o ack", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w), { group: w.id });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await walletBalance(w.id)) === "75.00");
    await waitFor(async () => (await depth(q.main)) === 0);

    expect(await debitCount(w.id)).toBe(1);
    expect(await inboxCount()).toBe(1);
    expect(await ctx.eventTypes()).toContain("WagerTransactionProcessed");
    expect(await depth(q.dlq)).toBe(0);
    await expectInvariant(w.id);
  }, 30_000);

  test("rejeição de negócio é persistida e a mensagem é confirmada, sem ir para a DLQ", async () => {
    const w = await newWallet("10.00");
    const msg = wagerMessage(w, { ext: "ext-poor" });
    await enqueue(msg, { group: w.id });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await depth(q.main)) === 0);

    const [row] = await rows<{ status: string; failure_code: string }>(
      "select status, failure_code from wager_transactions where external_transaction_id = ?",
      ["ext-poor"],
    );
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await walletBalance(w.id)).toBe("10.00");
    expect(await depth(q.dlq)).toBe(0);
    expect(await ctx.eventTypes()).toContain("WagerTransactionRejected");
  }, 30_000);
});

// Redelivery e duplicatas

describe("duplicatas", () => {
  test("a mesma mensagem entregue duas vezes não duplica o débito", async () => {
    const w = await newWallet("100.00");
    const msg = wagerMessage(w, { messageId: "msg-dup", ext: "ext-dup" });
    await enqueue(msg, { group: w.id, dedup: "send-1" });
    await enqueue(msg, { group: w.id, dedup: "send-2" });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await walletBalance(w.id)) === "75.00");
    await waitFor(async () => (await depth(q.main)) === 0);

    expect(await debitCount(w.id)).toBe(1);
    expect(await inboxCount()).toBe(1);
    expect(await depth(q.dlq)).toBe(0);
    await expectInvariant(w.id);
  }, 30_000);

  test("a mesma operação com outro messageId vira replay pela idempotency key", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w, { messageId: "msg-a", ext: "ext-same" }), { group: w.id });
    await enqueue(wagerMessage(w, { messageId: "msg-b", ext: "ext-same" }), { group: w.id });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await depth(q.main)) === 0);

    expect(await debitCount(w.id)).toBe(1);
    expect(await walletBalance(w.id)).toBe("75.00");
    expect(await inboxCount()).toBe(2);
  }, 30_000);

  test("a mesma key com payload diferente é conflito: confirma e mantém a original", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w, { ext: "ext-conflict", amount: "25.00" }), { group: w.id });
    await enqueue(wagerMessage(w, { ext: "ext-conflict", amount: "99.00" }), { group: w.id });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await depth(q.main)) === 0);

    expect(await walletBalance(w.id)).toBe("75.00");
    expect(await debitCount(w.id)).toBe(1);
    expect(await depth(q.dlq)).toBe(0);
  }, 30_000);
});

// DLQ e retry

describe("erros", () => {
  test("mensagens permanentemente inválidas vão direto para a DLQ, com o motivo", async () => {
    const w = await newWallet("100.00");
    const ghost = { id: Bun.randomUUIDv7(), playerId: "ghost" };
    const cases = [
      { body: "{ this is not json", code: "MALFORMED_MESSAGE" },
      { body: JSON.stringify({ ...wagerMessage(w), type: "SomethingElse" }), code: "MALFORMED_MESSAGE" },
      { body: JSON.stringify(wagerMessage(w, { amount: "25.123" })), code: "INVALID_MONEY" },
      { body: JSON.stringify(wagerMessage(ghost)), code: "WALLET_NOT_FOUND" },
    ];
    for (const [i, c] of cases.entries()) await enqueue(c.body, { group: `bad-${i}` });

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await depth(q.dlq)) === cases.length);
    await waitFor(async () => (await depth(q.main)) === 0);

    const dlq = await readDlq(cases.length);
    expect(dlq).toHaveLength(cases.length);
    expect(dlq.map((m) => m.attrs.errorCode).sort()).toEqual(cases.map((c) => c.code).sort());
    expect(dlq.every((m) => m.attrs.failureReason === "permanent")).toBe(true);
    expect(dlq.map((m) => m.body).sort()).toEqual(cases.map((c) => c.body).sort());

    expect(await walletBalance(w.id)).toBe("100.00");
    expect(await ctx.count("wager_transactions")).toBe(1);
  }, 30_000);

  test("erro transitório: tenta de novo com backoff e acaba processando, sem duplicar", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w), { group: w.id });

    const flaky = new ProbeProcessor(realProcessor, { failFirst: 2 });
    makeConsumer(flaky, { maxAttempts: 5 }).start();

    await waitFor(async () => (await walletBalance(w.id)) === "75.00", 30_000);
    await waitFor(async () => (await depth(q.main)) === 0, 30_000);

    expect(flaky.started).toBe(3);
    expect(flaky.completed).toBe(1);
    expect(await debitCount(w.id)).toBe(1);
    expect(await depth(q.dlq)).toBe(0);
  }, 60_000);

  test("erro transitório que não passa: esgota as tentativas e vai para a DLQ", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w), { group: w.id });

    const broken = new ProbeProcessor(realProcessor, { failAlways: true });
    makeConsumer(broken, { maxAttempts: 3 }).start();

    await waitFor(async () => (await depth(q.dlq)) === 1, 30_000);
    const [message] = await readDlq(1);

    expect(message?.attrs.failureReason).toBe("retries_exhausted");
    expect(message?.attrs.receiveCount).toBe("3");
    expect(broken.started).toBe(3);
    expect(await depth(q.main)).toBe(0);
    expect(await walletBalance(w.id)).toBe("100.00");
  }, 60_000);
});

// Crash e shutdown

describe("recuperação e encerramento", () => {
  test("worker morto depois do commit e antes do ack: a mensagem volta e vira replay", async () => {
    const w = await newWallet("100.00");
    await enqueue(wagerMessage(w), { group: w.id });

    const probe = new ProbeProcessor(realProcessor);
    makeConsumer(probe, {}, flakyAck(sqs, 1)).start();

    await waitFor(async () => (await walletBalance(w.id)) === "75.00"); 
    await waitFor(() => probe.completed >= 2, 30_000);
    await waitFor(async () => (await depth(q.main)) === 0, 30_000);

    expect(await debitCount(w.id)).toBe(1);
    expect(await walletBalance(w.id)).toBe("75.00");
    expect(await depth(q.dlq)).toBe(0);
    await expectInvariant(w.id);
  }, 60_000);

  test("SIGTERM: conclui a mensagem em andamento e devolve as que ainda não começou", async () => {
    const w = await newWallet("100.00");
    for (let i = 0; i < 3; i++) await enqueue(wagerMessage(w), { group: w.id });

    const slow = new ProbeProcessor(realProcessor, { delayMs: 400 });
    const first = makeConsumer(slow);
    first.start();
    await waitFor(() => slow.started >= 1);
    await first.stop();

    expect(slow.completed).toBe(slow.started);
    expect(slow.completed).toBeGreaterThanOrEqual(1);
    expect(await walletBalance(w.id)).toBe(`${100 - 25 * slow.completed}.00`);

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await walletBalance(w.id)) === "25.00", 30_000);
    await waitFor(async () => (await depth(q.main)) === 0, 30_000);

    expect(await debitCount(w.id)).toBe(3);
    await expectInvariant(w.id);
  }, 60_000);

  test("sem trabalho, o stop() devolve rápido: cancela o long poll", async () => {
    const consumer = makeConsumer(realProcessor, { waitTimeSeconds: 20 });
    consumer.start();
    await Bun.sleep(300);

    const startedAt = performance.now();
    await consumer.stop();
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 15_000);
});

// Paralelismo

describe("paralelismo", () => {
  test("wallets distintas em paralelo, e dentro de cada uma as apostas em ordem", async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet("100.00")));
    // 6 apostas de 25.00 por wallet: cabem exatamente 4.
    for (let i = 0; i < 6; i++) {
      for (const w of wallets) await enqueue(wagerMessage(w), { group: w.id });
    }

    makeConsumer(realProcessor).start();
    await waitFor(async () => (await depth(q.main)) === 0, 60_000);

    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe("0.00");
      expect(await debitCount(w.id)).toBe(4);
      await expectInvariant(w.id);
    }
    expect(await depth(q.dlq)).toBe(0);
  }, 90_000);
});