import { InvalidMoneyError, InvalidTransactionError } from "../../domain/errors/domain-errors";
import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { EventContext, IntegrationEvent } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/wager-events";
import { Money, type MoneyProps } from "../../domain/money/money";
import { FailureCode } from "../../domain/wager/failure-code";
import { WagerTransaction } from "../../domain/wager/wager-transaction";
import { WagerTransactionKind as Kind } from "../../domain/wager/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../domain/wager/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { classifyLockConflict } from "../lock-conflicts";
import { computePayloadHash } from "../payload-hash";
import { nextPendingReferenceAttemptAt, PENDING_REFERENCE_POLICY } from "../pending-reference-policy";
import {
  type LoggerPort,
  type MetricsPort,
  noopLogger,
  noopMetrics,
} from "../ports/observability";
import type { Repositories, StoredWagerTransaction, UnitOfWork } from "../ports/repositories";

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: Status;
  balance?: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export type PendingReferenceOutcome =
  | {
      kind: "settled";
      transactionKind: Kind;
      attempts: number;
      result: ProcessWagerTransactionResult;
    }
  | { kind: "waiting"; attempts: number; nextAttemptAt: Date }
  | {
      kind: "expired";
      transactionKind: Kind;
      attempts: number;
      result: ProcessWagerTransactionResult;
    };

interface Meta {
  correlationId: string;
  causationId: string;
}

interface Parsed extends Meta {
  tx: WagerTransaction;
  inbox?: { consumerName: string; messageId: string };
}

type Source = "http" | "sqs";

type Retry = { attempts: number; nextAttemptAt: Date | null };

type Decision =
  | { type: "reject"; code: FailureCode }
  | { type: "wait" } 
  | { type: "record"; referenceId?: string }
  | { type: "move"; direction: LedgerDirection; referenceId?: string };

type Settleable = Exclude<Decision, { type: "wait" }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reject = (code: FailureCode): Decision => ({ type: "reject", code });

export class ProcessWagerTransactionUseCase {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly logger: LoggerPort;
  private readonly metrics: MetricsPort;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      now?: () => Date;
      newId?: () => string;
      logger?: LoggerPort;
      metrics?: MetricsPort;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => Bun.randomUUIDv7());
    this.logger = deps.logger ?? noopLogger;
    this.metrics = deps.metrics ?? noopMetrics;
  }

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const source: Source = command.inbox ? "sqs" : "http";
    const startedAt = performance.now();
    let parsed: Parsed | undefined;
    try {
      // Payload inválido falha aqui, antes de abrir transação e sem gravar nada.
      parsed = this.parse(command);
      const current = parsed;
      const result = await this.deps.uow.run((repos) => this.process(repos, current));

      this.observeOutcome(current, result, source, startedAt);
      return result;
    } catch (error) {
      this.observeFailure(error, parsed, source, startedAt);
      throw error;
    }
  }

  /**
   * Reavalia, dentro de uma transação já aberta e com a wallet JÁ TRAVADA pelo chamador, uma
   * transação que aguardava a referência. Usa exatamente as mesmas regras da primeira entrega.
   */
  async reevaluatePendingReference(
    repos: Repositories,
    stored: StoredWagerTransaction,
    wallet: Wallet,
    at: Date,
  ): Promise<PendingReferenceOutcome> {
    const tx = stored.transaction;
    const attempt = stored.attempts + 1;
  
    const meta: Meta = { correlationId: this.newId(), causationId: tx.id };

    const decision = await this.decide(repos, tx, wallet);

    if (decision.type === "wait") {
      if (attempt >= PENDING_REFERENCE_POLICY.maxAttempts) {
        tx.reject(FailureCode.ReferenceNotFound);
        await repos.transactions.save(tx, {
          resultingBalance: wallet.balance,
          retry: { attempts: attempt, nextAttemptAt: null },
        });
        await this.emit(repos, WagerTransactionRejected.from(tx, this.eventContext(meta, at)));
        return {
          kind: "expired",
          transactionKind: tx.kind,
          attempts: attempt,
          result: this.toResult(tx, wallet.balance, false),
        };
      }
      const nextAttemptAt = nextPendingReferenceAttemptAt(attempt, at);
      await repos.transactions.save(tx, { retry: { attempts: attempt, nextAttemptAt } });
      return { kind: "waiting", attempts: attempt, nextAttemptAt };
    }

    const result = await this.applyDecision(repos, tx, wallet, decision, meta, at, {
      attempts: attempt,
      nextAttemptAt: null,
    });
    return { kind: "settled", transactionKind: tx.kind, attempts: attempt, result };
  }

  // Validação

  private parse(command: ProcessWagerTransactionCommand): Parsed {
    const required = {
      idempotencyKey: command.idempotencyKey,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidTransactionError(`${field} is required`);
      }
    }
    if (!UUID_PATTERN.test(command.walletId)) {
      throw new InvalidTransactionError("walletId must be a UUID");
    }
    if (!Object.values(Kind).includes(command.kind as Kind)) {
      throw new InvalidTransactionError(`Unknown kind: ${String(command.kind)}`);
    }
    if (typeof command.money !== "object" || command.money === null) {
      throw new InvalidMoneyError("money is required");
    }
    const reference = command.referenceExternalTransactionId;
    if (reference !== undefined && (typeof reference !== "string" || reference.trim() === "")) {
      throw new InvalidTransactionError("referenceExternalTransactionId cannot be empty");
    }

    const money = Money.from(command.money);
    const kind = command.kind as Kind;
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: reference,
    });

    const tx = WagerTransaction.create({
      id: this.newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money,
      referenceExternalTransactionId: reference,
      now: this.now(),
    });

    return {
      tx,
      correlationId: command.correlationId ?? this.newId(),
      causationId: command.causationId ?? command.idempotencyKey,
      inbox: command.inbox,
    };
  }

  // Fluxo principal

  private async process(repos: Repositories, p: Parsed): Promise<ProcessWagerTransactionResult> {
    const { tx } = p;
    const at = this.now();

    // 1. Lock só desta wallet. Quem chega depois espera aqui, e as outras wallets seguem em paralelo.
    const lockStartedAt = performance.now();
    const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);
    this.metrics.observe("wallet_lock_wait_seconds", (performance.now() - lockStartedAt) / 1000);
    if (!wallet) throw new WalletNotFoundError(`Wallet ${tx.walletId} was not found`);

    // 2. Inbox: se a mensagem já foi vista, segue para o replay idempotente.
    const inbox = p.inbox
      ? InboxMessage.receive({
          messageId: p.inbox.messageId,
          consumerName: p.inbox.consumerName,
          payloadHash: tx.payloadHash,
          now: at,
        })
      : undefined;
    if (inbox) await repos.inbox.receive(inbox);

    const result = await this.applyOrReplay(repos, p, wallet, at);

    if (inbox) {
      inbox.markProcessed(at);
      await repos.inbox.markProcessed(inbox);
    }
    return result;
  }

  private async applyOrReplay(
    repos: Repositories,
    p: Parsed,
    wallet: Wallet,
    at: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const { tx } = p;

    // 3. Idempotência persistente.
    const existing = await this.findExisting(repos, tx);
    if (existing) return this.replay(existing, tx.payloadHash);

    if (!(await repos.transactions.insertIfAbsent(tx))) {
      const winner = await this.findExisting(repos, tx);
      if (!winner) throw new Error("Idempotency insert conflicted but no row was found");
      return this.replay(winner, tx.payloadHash);
    }

    // 4. Regras de negócio.
    const decision = await this.decide(repos, tx, wallet);

    if (decision.type === "wait") {
      tx.markPendingReference();
      await repos.transactions.save(tx, {
        retry: { attempts: 0, nextAttemptAt: nextPendingReferenceAttemptAt(0, at) },
      });
      await this.emit(repos, WagerTransactionPendingReference.from(tx, this.eventContext(p, at)));
      return this.toResult(tx, undefined, false);
    }

    return this.applyDecision(repos, tx, wallet, decision, p, at);
  }

  /** Grava o desfecho: saldo, ledger, transação e eventos. Tudo na transação SQL que já está aberta. */
  private async applyDecision(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
    decision: Settleable,
    meta: Meta,
    at: Date,
    retry?: Retry,
  ): Promise<ProcessWagerTransactionResult> {
    const ctx = () => this.eventContext(meta, at);

    switch (decision.type) {
      case "reject": {
        tx.reject(decision.code);
        await repos.transactions.save(tx, { resultingBalance: wallet.balance, retry });
        await this.emit(repos, WagerTransactionRejected.from(tx, ctx()));
        return this.toResult(tx, wallet.balance, false);
      }

      case "record": {
        tx.markProcessed(decision.referenceId, at);
        await repos.transactions.save(tx, { resultingBalance: wallet.balance, retry });
        await this.emit(repos, WagerTransactionProcessed.from(tx, wallet.balance, ctx()));
        return this.toResult(tx, wallet.balance, false);
      }

      case "move": {
        const expectedVersion = wallet.version;
        const movement = { entryId: this.newId(), transactionId: tx.id, money: tx.money, at };
        const entry =
          decision.direction === LedgerDirection.Credit
            ? wallet.credit(movement)
            : wallet.debit(movement);

        await repos.ledger.append(entry);
        await repos.wallets.save(wallet, expectedVersion);

        tx.markProcessed(decision.referenceId, at);
        await repos.transactions.save(tx, { resultingBalance: wallet.balance, retry });

        await this.emit(repos, WagerTransactionProcessed.from(tx, wallet.balance, ctx()));
        await this.emit(repos, WalletBalanceChanged.from(wallet, entry, ctx()));
        return this.toResult(tx, wallet.balance, false);
      }
    }
  }

  // Decisão

  private async decide(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
  ): Promise<Decision> {
    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
    if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const stored = await repos.transactions.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (!stored) return { type: "wait" };

      reference = stored.transaction;
      if (
        reference.walletId !== tx.walletId ||
        reference.playerId !== tx.playerId ||
        reference.roundId !== tx.roundId ||
        reference.money.currency !== tx.money.currency
      ) {
        return reject(FailureCode.ReferenceMismatch);
      }
      if (!tx.acceptsReferenceKind(reference.kind)) {
        return reject(FailureCode.ReferenceKindNotAllowed);
      }
      if (reference.status === Status.Rejected || reference.status === Status.Failed) {
        return reject(FailureCode.ReferenceNotProcessed);
      }
      if (reference.status !== Status.Processed) return { type: "wait" };
    }
    const referenceId = reference?.id;

    switch (tx.kind) {
      case Kind.Loss:
        return { type: "record", referenceId };

      case Kind.Win:
        return { type: "move", direction: LedgerDirection.Credit, referenceId };

      case Kind.Bet:
        if (wallet.balance.isLessThan(tx.money)) return reject(FailureCode.InsufficientFunds);
        return { type: "move", direction: LedgerDirection.Debit };

      case Kind.Refund:
      case Kind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError(`${tx.kind} requires a reference`);
        }
        if (!tx.money.equals(reference.money)) return reject(FailureCode.AmountMismatch);
        if (await repos.transactions.existsProcessedReversalOf(reference.id)) {
          return reject(FailureCode.AlreadyReversed);
        }
        const direction = tx.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
          return reject(FailureCode.ReversalWouldOverdraw);
        }
        return { type: "move", direction, referenceId };
      }

      default:
        throw new InvalidTransactionError(`${tx.kind} cannot be processed here`);
    }
  }

  // Auxiliares

  private async findExisting(
    repos: Repositories,
    tx: WagerTransaction,
  ): Promise<StoredWagerTransaction | undefined> {
    return (
      (await repos.transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey)) ??
      (await repos.transactions.findByExternalId(tx.providerId, tx.externalTransactionId))
    );
  }

  private replay(
    stored: StoredWagerTransaction,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (!stored.transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        "The idempotency key was already used with a different payload",
      );
    }
    return this.toResult(stored.transaction, stored.resultingBalance, true);
  }

  private toResult(
    tx: WagerTransaction,
    balance: Money | undefined,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(balance !== undefined && { balance }),
      ...(tx.failureCode !== undefined && { failureCode: tx.failureCode }),
      idempotentReplay,
    };
  }

  private eventContext(meta: Meta, at: Date): EventContext {
    return {
      eventId: this.newId(),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      occurredAt: at,
    };
  }

  private async emit(repos: Repositories, event: IntegrationEvent<unknown>): Promise<void> {
    await repos.outbox.add(OutboxMessage.enqueue(event));
  }

  // Observabilidade

  /** O log e a métrica nunca podem quebrar uma operação que já foi confirmada. */
  private safely(work: () => void): void {
    try {
      work();
    } catch {
    }
  }

  private observeOutcome(
    parsed: Parsed,
    result: ProcessWagerTransactionResult,
    source: Source,
    startedAt: number,
  ): void {
    this.safely(() => {
      const durationMs = performance.now() - startedAt;
      const { tx } = parsed;

      this.metrics.observe("wager_processing_duration_seconds", durationMs / 1000, {
        source,
        outcome: result.status.toLowerCase(),
      });
      if (result.idempotentReplay) {
        this.metrics.increment("duplicates_detected_total", { source });
      } else {
        this.metrics.increment("wager_transactions_total", {
          kind: tx.kind,
          status: result.status,
          source,
        });
      }

      this.logger.info("transaction_decided", {
        correlationId: parsed.correlationId,
        messageId: parsed.inbox?.messageId,
        transactionId: result.transactionId,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        source,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
        durationMs: Math.round(durationMs),
      });
    });
  }

  private observeFailure(
    error: unknown,
    parsed: Parsed | undefined,
    source: Source,
    startedAt: number,
  ): void {
    this.safely(() => {
      this.metrics.observe(
        "wager_processing_duration_seconds",
        (performance.now() - startedAt) / 1000,
        { source, outcome: "error" },
      );

      const context = {
        correlationId: parsed?.correlationId,
        messageId: parsed?.inbox?.messageId,
        walletId: parsed?.tx.walletId,
        providerId: parsed?.tx.providerId,
        source,
      };

      const lockReason = classifyLockConflict(error);
      if (lockReason) {
        this.metrics.increment("lock_conflicts_total", { reason: lockReason });
        this.logger.warn("wallet_lock_conflict", { ...context, reason: lockReason });
      }

      if (error instanceof IdempotencyConflictError) {
        this.metrics.increment("idempotency_conflicts_total", { source });
        this.logger.warn("idempotency_conflict", context);
      }
    });
  }
}