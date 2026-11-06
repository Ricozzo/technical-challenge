import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerPage,
  LedgerRepository,
  ReconciliationSnapshot,
} from "../../../application/ports/repositories";
import type { LedgerDirection } from "../../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { moneyFromDb, query, type Row } from "../db-helpers";

function toEntry(row: Row): WalletLedgerEntry {
  const currency = row.currency as string;
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: moneyFromDb(row.amount, currency),
    balanceBefore: moneyFromDb(row.balance_before, currency),
    balanceAfter: moneyFromDb(row.balance_after, currency),
    createdAt: new Date(row.created_at),
  });
}

export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await query(
      this.em,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toJSON().amount,
        entry.money.currency,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ],
    );
  }

  async reconstructBalance(walletId: string, currency: string) {
    const rows = await query(
      this.em,
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as balance,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] ?? { balance: "0.00", entries: 0 };
    return { balance: moneyFromDb(row.balance, currency), entries: Number(row.entries) };
  }

  async listPage(walletId: string, opts: { before?: string; limit: number }): Promise<LedgerPage> {
    const before = opts.before ?? null;
    const rows = await query(
      this.em,
      `select seq::text as seq, id, wallet_id, transaction_id, direction, amount::text as amount,
              currency, balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and (?::bigint is null or seq < ?::bigint)
        order by seq desc
        limit ?`,
      [walletId, before, before, opts.limit + 1], // um a mais, só para saber se há próxima página
    );
    return {
      items: rows.slice(0, opts.limit).map((row) => ({ seq: String(row.seq), entry: toEntry(row) })),
      hasMore: rows.length > opts.limit,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const rows = await query(
      this.em,
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      stored: moneyFromDb(row.stored, row.currency),
      calculated: moneyFromDb(row.calculated, row.currency),
      entries: Number(row.entries),
    };
  }
}