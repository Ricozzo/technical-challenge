import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { Wallet } from "../../domain/wallet/wallet";
import { decodeCursor, encodeCursor, parseLimit } from "../cursor";
import { InvalidQueryError, TransactionNotFoundError, WalletNotFoundError } from "../errors";
import type { StoredWagerTransaction, UnitOfWork } from "../ports/repositories";
import { isUuid } from "../uuid";

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

/** Casos de uso de leitura. */
export class WagerQueries {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  async getWallet(walletId: string): Promise<Wallet> {
    this.assertUuid(walletId, "walletId");
    const wallet = await this.deps.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} was not found`);
    return wallet;
  }

  async listLedger(
    walletId: string,
    query: { cursor?: unknown; limit?: unknown },
  ): Promise<LedgerPageResult> {
    this.assertUuid(walletId, "walletId");
    const limit = parseLimit(query.limit);
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    return this.deps.uow.run(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) {
        throw new WalletNotFoundError(`Wallet ${walletId} was not found`);
      }
      const page = await repos.ledger.listPage(walletId, { before, limit });
      const last = page.items.at(-1);
      return {
        entries: page.items.map((item) => item.entry),
        nextCursor: page.hasMore && last ? encodeCursor(last.seq) : null,
      };
    });
  }

  async getTransactionById(transactionId: string): Promise<StoredWagerTransaction> {
    this.assertUuid(transactionId, "transactionId");
    const stored = await this.deps.uow.run((repos) => repos.transactions.findById(transactionId));
    if (!stored) throw new TransactionNotFoundError(`Transaction ${transactionId} was not found`);
    return stored;
  }

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction> {
    const stored = await this.deps.uow.run((repos) =>
      repos.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!stored) {
      throw new TransactionNotFoundError(
        `Transaction ${externalTransactionId} of provider ${providerId} was not found`,
      );
    }
    return stored;
  }

  private assertUuid(value: string, name: string): void {
    if (!isUuid(value)) throw new InvalidQueryError(`${name} must be a UUID`);
  }
}