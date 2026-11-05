import { LedgerDirection } from "../ledger/ledger-direction";
import { Money } from "../money/money";
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from "../errors/domain-errors";
import { FailureCode, isInfrastructureFailure } from "./failure-code";
import { WagerTransactionKind as Kind } from "./wager-transaction-kind";
import { WagerTransactionStatus as Status } from "./wager-transaction-status";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  now?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

const ALLOWED_TRANSITIONS: Record<Status, readonly Status[]> = {
  [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.PendingReference]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

const ACCEPTED_REFERENCE_KINDS: Partial<Record<Kind, readonly Kind[]>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: Kind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: Status,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidTransactionError("OPENING is internal and cannot be submitted");
    }
    WagerTransaction.validateShape(props);
    return WagerTransaction.build(props, props.now ?? new Date());
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    now?: Date;
  }): WagerTransaction {
    return WagerTransaction.build(
      {
        id: props.id,
        providerId: "internal",
        externalTransactionId: `opening:${props.walletId}`,
        idempotencyKey: `internal:opening:${props.walletId}`,
        payloadHash: "internal",
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: "opening",
        gameId: "opening",
        kind: Kind.Opening,
        money: props.money,
      },
      props.now ?? new Date(),
    );
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
    );
  }

  get status(): Status {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }


  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionError(`${this.kind} cannot be processed without a reference`);
    }
    this.transitionTo(Status.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.transitionTo(Status.PendingReference);
  }

  reject(code: FailureCode): void {
    if (isInfrastructureFailure(code)) {
      throw new InvalidTransactionError(`${code} is an infrastructure code, use fail()`);
    }
    this.transitionTo(Status.Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    if (!isInfrastructureFailure(code)) {
      throw new InvalidTransactionError(`${code} is a business code, use reject()`);
    }
    this.transitionTo(Status.Failed);
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  acceptsReferenceKind(referenceKind: Kind): boolean {
    return ACCEPTED_REFERENCE_KINDS[this.kind]?.includes(referenceKind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Opening:
      case Kind.Win:
      case Kind.Refund:
        return LedgerDirection.Credit;
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Loss:
        throw new InvalidTransactionError("LOSS does not produce a ledger entry");
      case Kind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError("ROLLBACK needs its reference to define the direction");
        }
        if (!this.acceptsReferenceKind(reference.kind)) {
          throw new InvalidTransactionError(`ROLLBACK cannot reference ${reference.kind}`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private transitionTo(next: Status): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`Cannot move from ${this._status} to ${next}`);
    }
    this._status = next;
  }

  private static validateShape(props: CreateWagerTransactionProps): void {
    const needsReference = props.kind === Kind.Refund || props.kind === Kind.Rollback;
    const reference = props.referenceExternalTransactionId;

    if (needsReference && !reference) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === Kind.Bet && reference) {
      throw new InvalidTransactionError("BET cannot have a reference");
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidTransactionError("A transaction cannot reference itself");
    }
    // LOSS pode ter valor zero. Todos os outros precisam de valor positivo.
    if (props.kind !== Kind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(`${props.kind} amount must be positive`);
    }
  }

  private static build(props: CreateWagerTransactionProps, now: Date): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      now,
      Status.Pending,
    );
  }
}