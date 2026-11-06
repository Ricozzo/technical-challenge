import { DomainError } from "../domain/errors/domain-errors";

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

export class ConcurrentModificationError extends DomainError {
  readonly code = "CONCURRENT_MODIFICATION";
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}