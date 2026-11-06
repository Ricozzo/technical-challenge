import { SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { LoggerPort, MetricsPort } from "./application/ports/observability";
import type { UnitOfWork } from "./application/ports/repositories";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction";
import { WagerQueries } from "./application/use-cases/queries";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { MetricsRegistry } from "./infrastructure/observability/metrics-registry";
import { buildConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { ProvidersController } from "./interfaces/http/providers.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { LOGGER, METRICS, ORM, SQS_CLIENT, UNIT_OF_WORK } from "./tokens";

/** Fecha o pool do banco e o cliente SQS quando a aplicação encerra. */
@Injectable()
export class ResourceLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

/** Raiz de composição: é aqui, e só aqui, que as portas encontram as implementações. */
@Module({
  controllers: [
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ORM, useFactory: () => MikroORM.init(buildConfig()) },
    { provide: UNIT_OF_WORK, inject: [ORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: LOGGER, useFactory: () => new JsonLogger() },
    { provide: METRICS, useFactory: () => new MetricsRegistry() },
    {
      provide: SQS_CLIENT,
      useFactory: () =>
        new SQSClient({
          region: process.env.AWS_REGION ?? "us-east-1",
          endpoint: process.env.AWS_ENDPOINT_URL,
        }),
    },
    {
      provide: OpenWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new OpenWalletUseCase({ uow }),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ProcessWagerTransactionUseCase({ uow }),
    },
    {
      provide: WagerQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new WagerQueries({ uow }),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, LOGGER, METRICS],
      useFactory: (uow: UnitOfWork, logger: LoggerPort, metrics: MetricsPort) =>
        new ReconcileWalletUseCase({ uow, logger, metrics }),
    },
    ResourceLifecycle,
  ],
})
export class AppModule {}