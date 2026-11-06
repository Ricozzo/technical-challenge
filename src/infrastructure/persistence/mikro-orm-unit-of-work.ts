import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { Repositories, UnitOfWork } from "../../application/ports/repositories";
import { createRepositories } from "./repositories";

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em
      .fork()
      .transactional((em) => work(createRepositories(em as unknown as EntityManager)));
  }
}