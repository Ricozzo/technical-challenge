import { SQSClient } from "@aws-sdk/client-sqs";
import { RetryPendingReferencesUseCase } from "./application/use-cases/retry-pending-references";
import { PendingReferenceWorker } from "./interfaces/workers/pending-reference.worker";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "./application/ports/event-publisher";
import type { LoggerPort, MetricsPort } from "./application/ports/observability";
import type { UnitOfWork } from "./application/ports/repositories";
import { OpenWalletUseCase } from "./application/use-cases/open-wallet";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction";
import { PublishOutboxUseCase } from "./application/use-cases/publish-outbox";
import { WagerQueries } from "./application/use-cases/queries";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet";
import { OutboxPublisherWorker } from "./infrastructure/messaging/outbox-publisher.worker";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { MetricsRegistry } from "./infrastructure/observability/metrics-registry";
import { buildConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { HealthController } from "./interfaces/http/health.controller";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { ProvidersController } from "./interfaces/http/providers.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { WagerQueueConsumer } from "./interfaces/sqs/wager-consumer";
import { EVENT_PUBLISHER, LOGGER, METRICS, ORM, SQS_CLIENT, UNIT_OF_WORK } from "./tokens";


function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/**
 * Fecha o pool do banco e o cliente SQS por último. O onApplicationShutdown só roda depois
 * de todos os onModuleDestroy, então o consumidor e o publisher já terminaram o que faziam.
 */
@Injectable()
export class ResourceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

/** Liga o publisher da outbox no boot e o desliga, esperando a rodada em andamento, no encerramento. */
@Injectable()
export class OutboxPublisherLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(OutboxPublisherWorker) private readonly worker: OutboxPublisherWorker) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== "false") this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }
}

/** Liga o consumidor SQS no boot e, no SIGTERM, conclui a mensagem em andamento antes de sair. */
@Injectable()
export class WagerConsumerLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(WagerQueueConsumer) private readonly consumer: WagerQueueConsumer) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== "false") this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }
}

/** Liga o worker de PENDING_REFERENCE no boot e o desliga, esperando a rodada em andamento, no encerramento. */
@Injectable()
export class PendingReferenceLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED !== "false") this.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
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
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT],
      useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, requiredEnv("SQS_EVENTS_QUEUE_URL")),
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
    {
      provide: PublishOutboxUseCase,
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, LOGGER, METRICS],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, logger: LoggerPort, metrics: MetricsPort) =>
        new PublishOutboxUseCase({
          uow,
          publisher,
          logger,
          metrics,
          batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 20),
        }),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutboxUseCase, LOGGER],
      useFactory: (useCase: PublishOutboxUseCase, logger: LoggerPort) =>
        new OutboxPublisherWorker({
          useCase,
          logger,
          idleDelayMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500),
        }),
    },
    {
      provide: WagerQueueConsumer,
      inject: [SQS_CLIENT, ProcessWagerTransactionUseCase, LOGGER, METRICS],
      useFactory: (
        sqs: SQSClient,
        processor: ProcessWagerTransactionUseCase,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new WagerQueueConsumer({
          sqs,
          queueUrl: requiredEnv("SQS_WAGER_QUEUE_URL"),
          dlqUrl: requiredEnv("SQS_WAGER_DLQ_URL"),
          processor,
          logger,
          metrics,
          maxAttempts: Number(process.env.SQS_CONSUMER_MAX_ATTEMPTS ?? 5),
          waitTimeSeconds: Number(process.env.SQS_CONSUMER_WAIT_TIME_SECONDS ?? 20),
        }),
    },
        {
      provide: RetryPendingReferencesUseCase,
      inject: [UNIT_OF_WORK, ProcessWagerTransactionUseCase, LOGGER, METRICS],
      useFactory: (
        uow: UnitOfWork,
        processor: ProcessWagerTransactionUseCase,
        logger: LoggerPort,
        metrics: MetricsPort,
      ) =>
        new RetryPendingReferencesUseCase({
          uow,
          evaluator: processor,
          logger,
          metrics,
          batchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 20),
        }),
    },
    {
      provide: PendingReferenceWorker,
      inject: [RetryPendingReferencesUseCase, LOGGER],
      useFactory: (useCase: RetryPendingReferencesUseCase, logger: LoggerPort) =>
        new PendingReferenceWorker({
          useCase,
          logger,
          idleDelayMs: Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1000),
        }),
    },
    PendingReferenceLifecycle,
    OutboxPublisherLifecycle,
    WagerConsumerLifecycle,
    ResourceLifecycle,
  ],
})
export class AppModule {}