import type { EntityManager } from "@mikro-orm/postgresql";
import type { Repositories } from "../../../application/ports/repositories";
import { SqlInboxRepository } from "./inbox.repository";
import { SqlLedgerRepository } from "./ledger.repository";
import { SqlOutboxRepository } from "./outbox.repository";
import { SqlWagerTransactionRepository } from "./wager-transaction.repository";
import { SqlWalletRepository } from "./wallet.repository";

/** Todos os repositórios compartilham o mesmo EntityManager, e portanto a mesma transação. */
export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    inbox: new SqlInboxRepository(em),
    outbox: new SqlOutboxRepository(em),
  };
}