import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrentModificationError } from "../../../application/errors";
import type { WalletRepository } from "../../../application/ports/repositories";
import { Wallet } from "../../../domain/wallet/wallet";
import { moneyFromDb, query, type Row } from "../db-helpers";

const COLUMNS =
  "id, player_id, currency, balance::text as balance, version, created_at, updated_at";

function toWallet(row: Row): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: moneyFromDb(row.balance, row.currency),
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await query(
      this.em,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?::numeric, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return rows.length === 1;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const rows = await query(this.em, `select ${COLUMNS} from wallets where id = ?`, [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const rows = await query(this.em, `select ${COLUMNS} from wallets where id = ? for update`, [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await query(
      this.em,
      `update wallets set balance = ?::numeric, version = ?, updated_at = ?
       where id = ? and version = ?
       returning id`,
      [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      throw new ConcurrentModificationError(
        `Wallet ${wallet.id} is no longer at version ${expectedVersion}`,
      );
    }
  }
}