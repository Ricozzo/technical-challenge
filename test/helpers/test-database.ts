import { MikroORM } from "@mikro-orm/postgresql";
import { buildConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";

export async function createTestContext() {
  const orm = await MikroORM.init(buildConfig(process.env.DB_NAME_TEST ?? "wagering_test"));
  await orm.migrator.up();
  const uow = new MikroOrmUnitOfWork(orm);

  return {
    orm,
    uow,
    /** TRUNCATE não dispara os triggers de linha, então serve para limpar entre os testes. */
    reset: async () => {
      await orm.em.execute(
        "truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages restart identity cascade",
      );
    },
    count: async (table: string): Promise<number> => {
      const rows = (await orm.em.execute(`select count(*)::int as n from ${table}`)) as unknown as { n: number }[];
      return rows[0]?.n ?? 0;
    },
    close: () => orm.close(),
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;