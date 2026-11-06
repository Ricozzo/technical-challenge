import { Migration } from "@mikro-orm/migrations";

/**
 * A transação passa a poder ter moeda diferente da wallet, para que uma operação em moeda
 * errada seja persistida como REJECTED (CURRENCY_MISMATCH) e continue auditável.
 * A garantia financeira segue no ledger: lançamento só existe na moeda da wallet.
 */
export class Migration20261106100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions drop constraint wager_tx_wallet_fk`);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_wallet_fk
        foreign key (wallet_id) references wallets (id)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table wager_transactions drop constraint wager_tx_wallet_fk`);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_wallet_fk
        foreign key (wallet_id, currency) references wallets (id, currency)
    `);
  }
}