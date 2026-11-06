import { MikroORM } from "@mikro-orm/postgresql";
import { buildConfig } from "./mikro-orm.config";

const [command = "up", flag] = process.argv.slice(2);
const dbName = flag === "--test" ? (process.env.DB_NAME_TEST ?? "wagering_test") : undefined;

const orm = await MikroORM.init(buildConfig(dbName));
try {
  const migrator = orm.migrator;
  switch (command) {
    case "up":
      await migrator.up();
      break;
    case "down":
      await migrator.down();
      break;
    case "down-all":
      await migrator.down({ to: 0 });
      break;
    case "reset":
      await migrator.down({ to: 0 });
      await migrator.up();
      break;
    default:
      console.error(`Unknown command "${command}". Use: up | down | down-all | reset [--test]`);
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}