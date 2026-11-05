import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration20261105190000 } from "./migrations/Migration20261105190000";

export function buildConfig(dbName?: string) {
  return defineConfig({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "wagering",
    password: process.env.DB_PASSWORD ?? "wagering",
    dbName: dbName ?? process.env.DB_NAME ?? "wagering",
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        { name: "Migration20261105190000", class: Migration20261105190000 },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}