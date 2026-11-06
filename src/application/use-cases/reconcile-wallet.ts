import type { Money } from "../../domain/money/money";
import { InvalidQueryError, WalletNotFoundError } from "../errors";
import type { LoggerPort, MetricsPort } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";
import { isUuid } from "../uuid";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly deps: { uow: UnitOfWork; logger: LoggerPort; metrics: MetricsPort },
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    if (!isUuid(walletId)) throw new InvalidQueryError("walletId must be a UUID");

    const snapshot = await this.deps.uow.run((repos) => repos.ledger.reconcile(walletId));
    if (!snapshot) throw new WalletNotFoundError(`Wallet ${walletId} was not found`);

    const difference = snapshot.stored.subtract(snapshot.calculated);
    const consistent = difference.isZero();

    this.deps.metrics.increment("wallet_reconciliations_total", {
      result: consistent ? "consistent" : "divergent",
    });

    // Divergência nunca é corrigida em silêncio: vai para o log, para a métrica e para a resposta.
    if (!consistent) {
      this.deps.metrics.increment("wallet_reconciliation_divergences_total");
      this.deps.logger.error("wallet_reconciliation_divergence", {
        walletId,
        checkedEntries: snapshot.entries,
        difference: difference.toJSON().amount,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.stored,
      calculatedBalance: snapshot.calculated,
      difference,
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}