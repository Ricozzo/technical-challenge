import type { MetricsPort } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";

export interface OutboxStatsReport {
  pending: number;
  oldestAgeSeconds: number;
}

/**
 * Atualiza os gauges da outbox. Rodar o que o /metrics pede a cada scrape mantém o valor
 * sempre atual, sem timer. A idade do evento pendente mais antigo é o "outbox lag".
 */
export class ReportOutboxStatsUseCase {
  private readonly now: () => Date;

  constructor(private readonly deps: { uow: UnitOfWork; metrics: MetricsPort; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }

  async execute(): Promise<OutboxStatsReport> {
    const stats = await this.deps.uow.run((repos) => repos.outbox.stats());
    const oldestAgeSeconds = stats.oldestOccurredAt
      ? Math.max(0, (this.now().getTime() - stats.oldestOccurredAt.getTime()) / 1000)
      : 0;

    this.deps.metrics.set("outbox_pending_events", stats.pending);
    this.deps.metrics.set("outbox_oldest_pending_age_seconds", oldestAgeSeconds);
    return { pending: stats.pending, oldestAgeSeconds };
  }
}