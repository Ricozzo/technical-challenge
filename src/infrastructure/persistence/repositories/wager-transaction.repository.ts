import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  StoredWagerTransaction,
  WagerTransactionRepository,
} from "../../../application/ports/repositories";
import type { Money } from "../../../domain/money/money";
import type { FailureCode } from "../../../domain/wager/failure-code";
import { WagerTransaction } from "../../../domain/wager/wager-transaction";
import type { WagerTransactionKind } from "../../../domain/wager/wager-transaction-kind";
import type { WagerTransactionStatus } from "../../../domain/wager/wager-transaction-status";
import { moneyFromDb, query, type Row } from "../db-helpers";

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount::text as amount, currency,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  resulting_balance::text as resulting_balance, attempts, next_attempt_at, created_at, processed_at`;

function toStored(row: Row): StoredWagerTransaction {
  const transaction = WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: moneyFromDb(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: new Date(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  });
  return {
    transaction,
    resultingBalance:
      row.resulting_balance === null ? undefined : moneyFromDb(row.resulting_balance, row.currency),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
  };
}

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const rows = await query(
      this.em,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency,
          reference_external_transaction_id, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toJSON().amount,
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.status,
        tx.createdAt,
      ],
    );
    return rows.length === 1;
  }

  async findById(id: string): Promise<StoredWagerTransaction | undefined> {
    const rows = await query(this.em, `select ${COLUMNS} from wager_transactions where id = ?`, [id]);
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async findByIdempotencyKey(providerId: string, key: string): Promise<StoredWagerTransaction | undefined> {
    const rows = await query(
      this.em,
      `select ${COLUMNS} from wager_transactions where provider_id = ? and idempotency_key = ?`,
      [providerId, key],
    );
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async findByExternalId(providerId: string, externalId: string): Promise<StoredWagerTransaction | undefined> {
    const rows = await query(
      this.em,
      `select ${COLUMNS} from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async existsProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const rows = await query(
      this.em,
      `select 1 as found from wager_transactions
       where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
       limit 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async save(tx: WagerTransaction, opts: { resultingBalance?: Money } = {}): Promise<void> {
    const rows = await query(
      this.em,
      `update wager_transactions
          set status = ?, failure_code = ?, processed_at = ?, reference_transaction_id = ?,
              resulting_balance = coalesce(?::numeric, resulting_balance)
        where id = ?
        returning id`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        tx.referenceTransactionId ?? null,
        opts.resultingBalance?.toJSON().amount ?? null,
        tx.id,
      ],
    );
    if (rows.length !== 1) throw new Error(`Wager transaction ${tx.id} was not found`);
  }
}