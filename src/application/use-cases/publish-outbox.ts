import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { EventPublisher } from "../ports/event-publisher";
import type { LoggerPort, MetricsPort } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Uma rodada do publisher. Funciona com vários publishers ao mesmo tempo, porque os eventos
 * são pegos com SKIP LOCKED. A entrega é at-least-once: se o processo morrer depois de
 * publicar e antes do commit, o evento é publicado de novo, e o consumidor deduplica pelo eventId.
 */
export class PublishOutboxUseCase {
  readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      publisher: EventPublisher;
      logger: LoggerPort;
      metrics: MetricsPort;
      batchSize?: number;
      now?: () => Date;
    },
  ) {
    this.batchSize = deps.batchSize ?? 20;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(): Promise<PublishOutboxResult> {
    const outcome = await this.deps.uow.run(async (repos) => {
      const batch = await repos.outbox.claimDue(this.now(), this.batchSize);
      const published: OutboxMessage[] = [];
      const failed: OutboxMessage[] = [];

      for (const message of batch) {
        try {
          await this.deps.publisher.publish(message);
        } catch (error) {
          message.scheduleRetry(this.now());
          await repos.outbox.save(message, { error: describeError(error) });
          failed.push(message);
          this.deps.logger.warn("outbox_publish_failed", {
            eventId: message.id,
            eventType: message.eventType,
            walletId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            error: describeError(error),
          });
          // Com o broker fora do ar, insistir nos demais só gasta tempo. O resto fica para a próxima rodada.
          break;
        }
        message.markPublished(this.now());
        await repos.outbox.save(message);
        published.push(message);
      }
      return { claimed: batch.length, published, failed };
    });

    for (const message of outcome.published) {
      this.deps.metrics.increment("outbox_events_published_total", { event_type: message.eventType });
    }
    for (const message of outcome.failed) {
      this.deps.metrics.increment("outbox_publish_failures_total", { event_type: message.eventType });
    }

    return {
      claimed: outcome.claimed,
      published: outcome.published.length,
      failed: outcome.failed.length,
    };
  }
}