import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";

const dbName = process.env.DB_NAME_TEST ?? "wagering_test";
const sql = new SQL(
  `postgres://${process.env.DB_USER ?? "wagering"}:${process.env.DB_PASSWORD ?? "wagering"}` +
    `@${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? "5432"}/${dbName}`,
);

function migrate(command: string): void {
  const proc = Bun.spawnSync(
    [process.execPath, "src/infrastructure/persistence/migrate.ts", command, "--test"],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`migrate ${command} failed:\n${proc.stderr.toString()}${proc.stdout.toString()}`);
  }
}

async function rejectedWith(run: () => PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error("expected the database to reject the statement");
  expect(String((error as Error).message)).toMatch(pattern);
}

const uuid = () => Bun.randomUUIDv7();

async function seedWallet(o: { id?: string; player?: string; currency?: string; balance?: string } = {}) {
  const id = o.id ?? uuid();
  await sql`
    insert into wallets (id, player_id, currency, balance)
    values (${id}::uuid, ${o.player ?? `player-${id}`}, ${o.currency ?? "BRL"}, ${o.balance ?? "100.00"}::numeric)`;
  return id;
}

interface SeedTx {
  walletId: string;
  id?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  status?: string;
  provider?: string;
  ext?: string;
  idem?: string;
  ref?: string | null;
  refId?: string | null;
}

async function seedTx(o: SeedTx) {
  const id = o.id ?? uuid();
  const status = o.status ?? "PENDING";
  const provider = o.provider ?? "provider-a";
  const ext = o.ext ?? `ext-${id}`;
  const failure = status === "REJECTED" ? "INSUFFICIENT_FUNDS" : status === "FAILED" ? "INTERNAL_ERROR" : null;
  const processedAt = status === "PROCESSED" ? new Date().toISOString() : null;
  await sql`
    insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, processed_at)
    values
      (${id}::uuid, ${provider}, ${ext}, ${o.idem ?? `${provider}:${ext}`}, ${"hash"}, ${o.walletId}::uuid,
       ${"player-1"}, ${"round-1"}, ${"game-1"}, ${o.kind ?? "BET"}, ${o.amount ?? "25.00"}::numeric,
       ${o.currency ?? "BRL"}, ${o.ref ?? null}, ${o.refId ?? null}::uuid, ${status}, ${failure},
       ${processedAt}::timestamptz)`;
  return { id, ext };
}

beforeAll(() => migrate("reset"));
beforeEach(async () => {
  // TRUNCATE não dispara os triggers de linha, então serve para limpar entre os testes.
  await sql`truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages restart identity cascade`;
});
afterAll(async () => {
  await sql.close();
});

describe("wallets", () => {
  test("saldo negativo é rejeitado pelo banco", async () => {
    await rejectedWith(() => seedWallet({ balance: "-0.01" }), /wallets_balance_non_negative/);
  });

  test("uma wallet por player + moeda, mas moedas diferentes podem coexistir", async () => {
    await seedWallet({ player: "p1", currency: "BRL" });
    await rejectedWith(() => seedWallet({ player: "p1", currency: "BRL" }), /wallets_player_currency_uq/);
    await seedWallet({ player: "p1", currency: "USD" });
  });

  test("moeda precisa ter formato ISO-4217", async () => {
    await rejectedWith(() => seedWallet({ currency: "brl" }), /wallets_currency_format/);
  });
});

describe("wager_transactions", () => {
  test("uma transação em moeda diferente da wallet pode ser gravada, para auditar a rejeição", async () => {
    const w = await seedWallet({ currency: "BRL" });
    await seedTx({ walletId: w, currency: "USD" });
  });

  test("externalTransactionId é único por provider", async () => {
    const w = await seedWallet();
    await seedTx({ walletId: w, ext: "e1" });
    await rejectedWith(
      () => seedTx({ walletId: w, ext: "e1", idem: "outra-chave" }),
      /wager_tx_provider_external_uq/,
    );
  });

  test("REFUND e ROLLBACK exigem referência; BET não pode ter", async () => {
    const w = await seedWallet();
    await rejectedWith(() => seedTx({ walletId: w, kind: "REFUND" }), /wager_tx_reference_required/);
    await rejectedWith(() => seedTx({ walletId: w, kind: "BET", ref: "x" }), /wager_tx_bet_no_reference/);
  });

  test("só LOSS pode ter valor zero", async () => {
    const w = await seedWallet();
    await seedTx({ walletId: w, kind: "LOSS", amount: "0.00" });
    await rejectedWith(() => seedTx({ walletId: w, kind: "BET", amount: "0.00" }), /wager_tx_amount_valid/);
  });

  test("uma transação em moeda diferente da wallet pode ser gravada, para auditar a rejeição", async () => {
    const w = await seedWallet({ currency: "BRL" });
    await seedTx({ walletId: w, currency: "USD" });
  });

  test("REJECTED exige failureCode e PROCESSED exige processedAt", async () => {
    const w = await seedWallet();
    const { id } = await seedTx({ walletId: w });
    await rejectedWith(
      () => sql`update wager_transactions set status = 'REJECTED' where id = ${id}::uuid`,
      /wager_tx_failure_code_consistent/,
    );
    await rejectedWith(
      () => sql`update wager_transactions set status = 'PROCESSED' where id = ${id}::uuid`,
      /wager_tx_processed_at_consistent/,
    );
  });

  test("uma referência só pode ser revertida uma vez, qualquer que seja o tipo", async () => {
    const w = await seedWallet();
    const bet = await seedTx({ walletId: w, kind: "BET", status: "PROCESSED", ext: "bet-1" });
    await seedTx({ walletId: w, kind: "REFUND", status: "PROCESSED", ext: "refund-1", ref: "bet-1", refId: bet.id });

    await rejectedWith(
      () => seedTx({ walletId: w, kind: "ROLLBACK", status: "PROCESSED", ext: "rb-1", ref: "bet-1", refId: bet.id }),
      /wager_tx_single_reversal_uq/,
    );
    // Uma tentativa REJECTED não conta como reversão aplicada.
    await seedTx({ walletId: w, kind: "ROLLBACK", status: "REJECTED", ext: "rb-2", ref: "bet-1", refId: bet.id });
  });

  test("estado terminal não muda mais e a linha não pode ser apagada", async () => {
    const w = await seedWallet();
    const done = await seedTx({ walletId: w, status: "PROCESSED" });
    await rejectedWith(
      () => sql`update wager_transactions set status = 'PENDING', processed_at = null where id = ${done.id}::uuid`,
      /terminal/,
    );
    await rejectedWith(() => sql`delete from wager_transactions where id = ${done.id}::uuid`, /cannot be deleted/);
  });

  test("transição PENDING -> PROCESSED é permitida, mas o valor não pode ser alterado", async () => {
    const w = await seedWallet();
    const { id } = await seedTx({ walletId: w });
    await rejectedWith(
      () => sql`update wager_transactions set amount = 999.00 where id = ${id}::uuid`,
      /identity columns/,
    );
    await sql`update wager_transactions set status = 'PROCESSED', processed_at = now() where id = ${id}::uuid`;
  });
});

describe("wallet_ledger_entries", () => {
  async function entry(o: { walletId: string; txId: string; direction: string; amount: string; before: string; after: string }) {
    await sql`
      insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
      values
        (${uuid()}::uuid, ${o.walletId}::uuid, ${o.txId}::uuid, ${o.direction}, ${o.amount}::numeric, ${"BRL"},
         ${o.before}::numeric, ${o.after}::numeric)`;
  }

  test("aritmética incorreta é rejeitada", async () => {
    const w = await seedWallet();
    const tx = await seedTx({ walletId: w });
    await rejectedWith(
      () => entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "30.00", before: "100.00", after: "71.00" }),
      /ledger_arithmetic/,
    );
  });

  test("direção precisa bater com os saldos", async () => {
    const w = await seedWallet();
    const tx = await seedTx({ walletId: w });
    await rejectedWith(
      () => entry({ walletId: w, txId: tx.id, direction: "CREDIT", amount: "30.00", before: "100.00", after: "70.00" }),
      /ledger_arithmetic/,
    );
  });

  test("valor zero e saldo negativo são rejeitados", async () => {
    const w = await seedWallet();
    const tx = await seedTx({ walletId: w });
    await rejectedWith(
      () => entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "0.00", before: "100.00", after: "100.00" }),
      /ledger_amount_positive/,
    );
    await rejectedWith(
      () => entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "150.00", before: "100.00", after: "-50.00" }),
      /ledger_balances_non_negative/,
    );
  });

  test("no máximo um lançamento por transação e wallet", async () => {
    const w = await seedWallet();
    const tx = await seedTx({ walletId: w });
    await entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "30.00", before: "100.00", after: "70.00" });
    await rejectedWith(
      () => entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "10.00", before: "70.00", after: "60.00" }),
      /ledger_wallet_transaction_uq/,
    );
  });

  test("o lançamento precisa apontar para uma transação da mesma wallet", async () => {
    const w1 = await seedWallet({ player: "p1" });
    const w2 = await seedWallet({ player: "p2" });
    const txOfW1 = await seedTx({ walletId: w1 });
    await rejectedWith(
      () => entry({ walletId: w2, txId: txOfW1.id, direction: "DEBIT", amount: "30.00", before: "100.00", after: "70.00" }),
      /ledger_transaction_fk/,
    );
  });

  test("o ledger é imutável: UPDATE e DELETE falham", async () => {
    const w = await seedWallet();
    const tx = await seedTx({ walletId: w });
    await entry({ walletId: w, txId: tx.id, direction: "DEBIT", amount: "30.00", before: "100.00", after: "70.00" });

    await rejectedWith(() => sql`update wallet_ledger_entries set amount = 1.00`, /immutable/);
    await rejectedWith(() => sql`delete from wallet_ledger_entries`, /immutable/);
  });

  test("o lançamento precisa estar na moeda da wallet", async () => {
    const w = await seedWallet({ currency: "BRL" });
    const tx = await seedTx({ walletId: w });
    await rejectedWith(
      () => sql`
        insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
        values
          (${uuid()}::uuid, ${w}::uuid, ${tx.id}::uuid, ${"DEBIT"}, ${"10.00"}::numeric, ${"USD"},
           ${"100.00"}::numeric, ${"90.00"}::numeric)`,
      /ledger_wallet_fk/,
    );
  });
});

describe("inbox e outbox", () => {
  test("a inbox deduplica por (consumer_name, message_id)", async () => {
    await sql`insert into inbox_messages (consumer_name, message_id, payload_hash) values (${"c1"}, ${"m1"}, ${"h"})`;
    await rejectedWith(
      () => sql`insert into inbox_messages (consumer_name, message_id, payload_hash) values (${"c1"}, ${"m1"}, ${"h"})`,
      /inbox_messages_pkey/,
    );
    await sql`insert into inbox_messages (consumer_name, message_id, payload_hash) values (${"c2"}, ${"m1"}, ${"h"})`;
  });

  test("outbox não aceita attempts negativo", async () => {
    await rejectedWith(
      () => sql`
        insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
        values (${uuid()}::uuid, ${"agg"}, ${"WalletBalanceChanged"}, ${"{}"}::jsonb, now(), -1)`,
      /outbox_attempts_non_negative/,
    );
  });
});

describe("migrations", () => {
  test("são reversíveis: down remove tudo e up recria", async () => {
    migrate("down-all");
    const [gone] = await sql`select to_regclass('public.wallets') as t`;
    expect(gone?.t).toBeNull();

    migrate("up");
    const [back] = await sql`select to_regclass('public.wallets') as t`;
    expect(back?.t).not.toBeNull();
  });
});