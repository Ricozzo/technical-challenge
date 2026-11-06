export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  AlreadyReversed = "ALREADY_REVERSED",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  AmountMismatch = "AMOUNT_MISMATCH",
  PlayerMismatch = "PLAYER_MISMATCH",
  InternalError = "INTERNAL_ERROR",
}

const INFRASTRUCTURE_CODES: ReadonlySet<FailureCode> = new Set([FailureCode.InternalError]);

export const isInfrastructureFailure = (code: FailureCode): boolean =>
  INFRASTRUCTURE_CODES.has(code);