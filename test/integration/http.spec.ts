import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.setup";
import { createTestContext, type TestContext } from "../helpers/test-database";

process.env.DB_NAME = process.env.DB_NAME_TEST ?? "wagering_test";
process.env.OUTBOX_PUBLISHER_ENABLED = "false";
process.env.SQS_CONSUMER_ENABLED = "false";
process.env.PENDING_REFERENCE_WORKER_ENABLED = "false";
process.env.LOG_LEVEL = "warn";

let app: INestApplication;
let ctx: TestContext;
let base: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, { shutdownHooks: false });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

// Helpers

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const hasBody = opts.raw !== undefined || opts.body !== undefined;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: unknown = text === "" ? undefined : text;
  try {
    if (text !== "") body = JSON.parse(text);
  } catch {
  }
  return { status: res.status, body, headers: res.headers } as Reply;
}

const brl = (amount: string) => ({ amount, currency: "BRL" });

let playerSeq = 0;
async function createWallet(balance = "100.00") {
  const r = await call("POST", "/wallets", {
    body: { playerId: `player-${++playerSeq}`, initialBalance: brl(balance) },
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; playerId: string };
}

let extSeq = 0;
function payload(w: { id: string; playerId: string }, over: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: `ext-${++extSeq}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: brl("25.00"),
    ...over,
  };
}

const submit = (p: Record<string, unknown>, key?: string) =>
  call("POST", "/wagering/transactions", {
    body: p,
    headers: { "idempotency-key": key ?? `${p.providerId}:${p.externalTransactionId}` },
  });

// Wallets

describe("POST /wallets", () => {
  test("201 com o formato do contrato", async () => {
    const r = await call("POST", "/wallets", {
      body: { playerId: "p1", initialBalance: brl("1000.00") },
    });
    expect(r.status).toBe(201);
    expect(r.body.balance).toEqual(brl("1000.00"));
    expect(r.body.version).toBe(1);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("wallet duplicada para o mesmo player e moeda é 409", async () => {
    await call("POST", "/wallets", { body: { playerId: "p1", initialBalance: brl("10.00") } });
    const r = await call("POST", "/wallets", { body: { playerId: "p1", initialBalance: brl("10.00") } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("payload inválido é 400", async () => {
    const amount = await call("POST", "/wallets", { body: { playerId: "p1", initialBalance: brl("10.999") } });
    expect(amount.status).toBe(400);
    expect(amount.body.error.code).toBe("INVALID_MONEY");

    const json = await call("POST", "/wallets", { raw: "{ isto não é json" });
    expect(json.status).toBe(400);
    expect(json.body.error.code).toBe("INVALID_PAYLOAD");

    const empty = await call("POST", "/wallets", { body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("GET /wallets/:walletId", () => {
  test("200, 404 e 400 para id malformado", async () => {
    const w = await createWallet("50.00");
    const ok = await call("GET", `/wallets/${w.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toEqual(brl("50.00"));

    expect((await call("GET", `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    const bad = await call("GET", "/wallets/nao-e-uuid");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_QUERY");
  });
});

// Transações

describe("POST /wagering/transactions", () => {
  test("o header Idempotency-Key é obrigatório", async () => {
    const w = await createWallet();
    const r = await call("POST", "/wagering/transactions", { body: payload(w) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  test("200 ao processar e 200 com idempotentReplay no replay, com o mesmo saldo", async () => {
    const w = await createWallet("100.00");
    const p = payload(w);

    const first = await submit(p);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("PROCESSED");
    expect(first.body.balance).toEqual(brl("75.00"));
    expect(first.body.idempotentReplay).toBe(false);

    await submit(payload(w));

    const replay = await submit(p);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.balance).toEqual(brl("75.00"));
  });

  test("a mesma key com payload diferente é 409", async () => {
    const w = await createWallet();
    const p = payload(w);
    await submit(p);
    const r = await submit({ ...p, money: brl("99.00") });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("rejeição de negócio é 422 e traz o failureCode", async () => {
    const w = await createWallet("10.00");
    const r = await submit(payload(w));
    expect(r.status).toBe(422);
    expect(r.body.status).toBe("REJECTED");
    expect(r.body.failureCode).toBe("INSUFFICIENT_FUNDS");

    const replay = await submit(payload(w, { externalTransactionId: "ext-fixo" }), "k-fixa");
    const again = await submit(payload(w, { externalTransactionId: "ext-fixo" }), "k-fixa");
    expect(replay.status).toBe(422);
    expect(again.status).toBe(422);
    expect(again.body.idempotentReplay).toBe(true);
  });

  test("referência ausente é aceita com processamento pendente: 202", async () => {
    const w = await createWallet();
    const r = await submit(
      payload(w, { kind: "REFUND", referenceExternalTransactionId: "bet-que-nao-chegou" }),
    );
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("PENDING_REFERENCE");
  });

  test("wallet inexistente é 404, e payload inválido é 400", async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: "ghost" };
    expect((await submit(payload(ghost))).status).toBe(404);

    const w = await createWallet();
    const invalid = await submit(payload(w, { kind: "OPENING" }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_TRANSACTION");
  });

  test("cada situação tem um status distinto", async () => {
    const w = await createWallet("30.00");
    const processed = await submit(payload(w));
    const rejected = await submit(payload(w));
    const pending = await submit(payload(w, { kind: "REFUND", referenceExternalTransactionId: "nada" }));
    const invalid = await submit(payload(w, { money: brl("1.234") }));
    const p = payload(w);
    await submit(p);
    const conflict = await submit({ ...p, money: brl("1.00") });

    const statuses = [processed, pending, rejected, invalid, conflict].map((r) => r.status);
    expect(statuses).toEqual([200, 202, 422, 400, 409]);
    expect(new Set(statuses).size).toBe(5);
  });
});

describe("consultas de transação", () => {
  test("por id interno e por (provider, id externo)", async () => {
    const w = await createWallet();
    const p = payload(w);
    const done = await submit(p);

    const byId = await call("GET", `/wagering/transactions/${done.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.status).toBe("PROCESSED");
    expect(byId.body.balance).toEqual(brl("75.00"));
    expect(byId.body.money).toEqual(brl("25.00"));

    const byExternal = await call(
      "GET",
      `/providers/provider-a/wagering/transactions/${p.externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.id).toBe(done.body.transactionId);

    expect((await call("GET", `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call("GET", "/providers/provider-a/wagering/transactions/nao-existe")).status).toBe(404);
    expect((await call("GET", "/wagering/transactions/xyz")).status).toBe(400);
  });
});

// Ledger

describe("GET /wallets/:walletId/ledger", () => {
  test("paginação por cursor opaco, do mais novo para o mais antigo, sem repetir nem pular", async () => {
    const w = await createWallet("100.00");
    for (let i = 0; i < 5; i++) {
      expect((await submit(payload(w, { money: brl("1.00") }))).status).toBe(200);
    }

    const seen: Array<{ id: string; direction: string; balanceBefore: { amount: string } }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Reply = await call(
        "GET",
        `/wallets/${w.id}/ledger?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status).toBe(200);
      seen.push(...r.body.items);
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((e) => e.id)).size).toBe(6);
    expect(seen[0]?.direction).toBe("DEBIT");
    expect(seen.at(-1)?.direction).toBe("CREDIT");
    expect(seen.at(-1)?.balanceBefore.amount).toBe("0.00");
  });

  test("cursor e limit inválidos são 400; wallet inexistente é 404", async () => {
    const w = await createWallet();
    for (const query of ["cursor=abc", "cursor=", "limit=0", "limit=201", "limit=abc", "limit=1.5"]) {
      const r = await call("GET", `/wallets/${w.id}/ledger?${query}`);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_QUERY");
    }
    expect((await call("GET", `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

// Reconciliação

describe("POST /wallets/:walletId/reconciliation", () => {
  test("consistente, e depois uma divergência sinalizada, logada e contada", async () => {
    const w = await createWallet("100.00");
    await submit(payload(w));

    const ok = await call("POST", `/wallets/${w.id}/reconciliation`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      walletId: w.id,
      storedBalance: brl("75.00"),
      calculatedBalance: brl("75.00"),
      difference: brl("0.00"),
      consistent: true,
      checkedEntries: 2,
    });

    // Corrompe o saldo de propósito, por fora da aplicação.
    await ctx.orm.em.execute("update wallets set balance = 999.00 where id = ?", [w.id]);

    const bad = await call("POST", `/wallets/${w.id}/reconciliation`);
    expect(bad.status).toBe(200);
    expect(bad.body.consistent).toBe(false);
    expect(bad.body.storedBalance).toEqual(brl("999.00"));
    expect(bad.body.calculatedBalance).toEqual(brl("75.00"));
    expect(bad.body.difference).toEqual(brl("924.00"));

    const metrics = await call("GET", "/metrics");
    expect(metrics.body).toContain("wallet_reconciliation_divergences_total");

    expect((await call("POST", `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });
});

// Health

describe("health", () => {
  test("live e ready, sem autenticação", async () => {
    expect((await call("GET", "/health/live")).status).toBe(200);

    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: "up", sqs: "up" });
  });

  test("rota inexistente tem o mesmo formato de erro", async () => {
    const r = await call("GET", "/rota/que/nao/existe");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});

// Observabilidade

describe("observabilidade", () => {
  test("o correlation id é aceito, gerado quando falta e substituído quando inválido", async () => {
    const given = await call("GET", "/health/live", { headers: { "x-correlation-id": "corr-123" } });
    expect(given.headers.get("x-correlation-id")).toBe("corr-123");

    const generated = await call("GET", "/health/live");
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);

    const invalid = await call("GET", "/health/live", { headers: { "x-correlation-id": "x y" } });
    expect(invalid.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("GET /metrics expõe a latência HTTP por rota, os contadores e os gauges da outbox", async () => {
    const w = await createWallet("100.00");
    await call("GET", `/wallets/${w.id}`);
    await submit(payload(w));
    await call("GET", "/rota/que/nao/existe");

    const text = (await call("GET", "/metrics")).body as string;

    // O registro vive enquanto a aplicação vive, então os contadores acumulam entre os testes.
    expect(text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/wallets\/:walletId",status="200"\} \d+/,
    );
    expect(text).toMatch(
      /http_request_duration_seconds_count\{method="POST",route="\/wagering\/transactions",status="200"\} \d+/,
    );
    expect(text).toContain('route="unmatched"');
    expect(text).toContain("# HELP wager_transactions_total");
    expect(text).toMatch(/wager_transactions_total\{kind="BET",source="http",status="PROCESSED"\} \d+/);
    expect(text).toContain("wager_processing_duration_seconds_bucket");
    expect(text).toMatch(/^outbox_pending_events 3$/m);
    expect(text).toMatch(/^outbox_oldest_pending_age_seconds /m);
  });
});