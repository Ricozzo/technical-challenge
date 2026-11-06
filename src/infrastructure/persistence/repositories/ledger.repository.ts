import type { EntityManager } from "@mikro-orm/postgresql";
import type { LedgerRepository } from "../../../application/ports/repositories";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { moneyFromDb, query } from "../db-helpers";

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
}