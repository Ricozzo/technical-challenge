import { FailureCode } from "../../domain/wager/failure-code";
import { WagerTransactionStatus as Status } from "../../domain/wager/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import { WalletNotFoundError } from "../errors";
import { nextPendingReferenceAttemptAt, PENDING_REFERENCE_POLICY } from "../pending-reference-policy";
import type { LoggerPort, MetricsPort } from "../ports/observability";
import type {
  DuePendingReference,
  Repositories,
  StoredWagerTransaction,
  UnitOfWork,
} from "../ports/repositories";
import type { PendingReferenceOutcome } from "./process-wager-transaction";

export interface PendingReferenceEvaluator {
  reevaluatePendingReference(
    repos: Repositories,
    stored: StoredWagerTransaction,
    wallet: Wallet,
    at: Date,
  ): Promise<PendingReferenceOutcome>;
}

export interface RetryPendingReferencesResult {
  due: number;
  processed: number;
  rejected: number;
  waiting: number;
  expired: number;
  skipped: number;
  errors: number;
}

type ItemOutcome = { kind: "skipped" } | PendingReferenceOutcome;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Uma rodada do worker de PENDING_REFERENCE. Cada transação vencida é reavaliada na sua própria
 * transação SQL, com a ordem de locks: wallet, depois transação. Vários workers podem rodar ao
 * mesmo tempo: quem chega depois do lock vê que a transação já foi resolvida (ou reagendada) e pula.
 */
export class RetryPendingReferencesUseCase {
  readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      evaluator: PendingReferenceEvaluator;
      logger: LoggerPort;
      metrics: MetricsPort;
      batchSize?: number;
      now?: () => Date;
    },
  ) {
    this.batchSize = deps.batchSize ?? 20;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(): Promise<RetryPendingReferencesResult> {
    const roundStartedAt = this.now();
    const due = await this.deps.uow.run((repos) =>
      repos.transactions.listDuePendingReference(roundStartedAt, this.batchSize),
    );

    const result: RetryPendingReferencesResult = {
      due: due.length,
      processed: 0,
      rejected: 0,
      waiting: 0,
      expired: 0,
      skipped: 0,
      errors: 0,
    };

    for (const candidate of due) {
      const log = this.deps.logger.child({
        transactionId: candidate.id,
        walletId: candidate.walletId,
      });

      let outcome: ItemOutcome;
      try {
        outcome = await this.retryOne(candidate, roundStartedAt);
      } catch (error) {
        // Uma transação que quebra não pode travar as demais: segue para a próxima.
        result.errors++;
        log.error("pending_reference_retry_failed", { error: describeError(error) });
        this.deps.metrics.increment("pending_reference_retries_total", { outcome: "error" });
        await this.recordFailure(candidate, log);
        continue;
      }

      switch (outcome.kind) {
        case "skipped":
          result.skipped++;
          break;

        case "waiting":
          result.waiting++;
          this.deps.metrics.increment("pending_reference_retries_total", { outcome: "waiting" });
          break;

        case "expired":
          result.expired++;
          this.deps.metrics.increment("pending_reference_retries_total", { outcome: "expired" });
          log.warn("pending_reference_expired", {
            attempts: outcome.attempts,
            failureCode: outcome.result.failureCode,
          });
          break;

        case "settled": {
          const status = outcome.result.status;
          if (status === Status.Processed) result.processed++;
          else result.rejected++;
          this.deps.metrics.increment("pending_reference_retries_total", {
            outcome: status.toLowerCase(),
          });
          log.info("pending_reference_settled", {
            status,
            failureCode: outcome.result.failureCode,
            attempts: outcome.attempts,
          });
          break;
        }
      }
    }

    return result;
  }

  private retryOne(candidate: DuePendingReference, roundStartedAt: Date): Promise<ItemOutcome> {
    return this.deps.uow.run(async (repos): Promise<ItemOutcome> => {
      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) throw new WalletNotFoundError(`Wallet ${candidate.walletId} was not found`);

      const stored = await repos.transactions.findByIdForUpdate(candidate.id);
      if (!stored || stored.transaction.status !== Status.PendingReference) {
        return { kind: "skipped" };
      }
      if (stored.nextAttemptAt && stored.nextAttemptAt > roundStartedAt) {
        return { kind: "skipped" };
      }

      return this.deps.evaluator.reevaluatePendingReference(repos, stored, wallet, this.now());
    });
  }

  /**
   * Uma transação que quebra de forma persistente não pode ficar vencida para sempre, repetindo
   * o erro a cada rodada. Cada falha consome uma tentativa e adia a próxima; quando as tentativas
   * acabam, ela vira FAILED (erro permanente de infraestrutura, terminal e auditável).
   */
  private async recordFailure(candidate: DuePendingReference, log: LoggerPort): Promise<void> {
    try {
      const at = this.now();
      const marked = await this.deps.uow.run(async (repos) => {
        const stored = await repos.transactions.findByIdForUpdate(candidate.id);
        if (!stored || stored.transaction.status !== Status.PendingReference) return false;

        const tx = stored.transaction;
        const attempt = stored.attempts + 1;
        if (attempt >= PENDING_REFERENCE_POLICY.maxAttempts) {
          tx.fail(FailureCode.InternalError);
          await repos.transactions.save(tx, { retry: { attempts: attempt, nextAttemptAt: null } });
          return true;
        }
        await repos.transactions.save(tx, {
          retry: { attempts: attempt, nextAttemptAt: nextPendingReferenceAttemptAt(attempt, at) },
        });
        return false;
      });

      if (marked) {
        this.deps.metrics.increment("pending_reference_retries_total", { outcome: "failed" });
        log.error("pending_reference_failed_permanently", { failureCode: FailureCode.InternalError });
      }
    } catch (error) {
      log.warn("pending_reference_failure_not_recorded", { error: describeError(error) });
    }
  }
}