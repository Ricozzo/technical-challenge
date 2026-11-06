import type { StoredWagerTransaction } from "../../application/ports/repositories";
import type { ProcessWagerTransactionResult } from "../../application/use-cases/process-wager-transaction";
import type { ReconciliationResult } from "../../application/use-cases/reconcile-wallet";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { WagerTransactionStatus as Status } from "../../domain/wager/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";

export function httpStatusFor(status: Status): number {
  switch (status) {
    case Status.Processed:
      return 200;
    case Status.Rejected:
      return 422;
    case Status.Pending:
    case Status.PendingReference:
      return 202;
    case Status.Failed:
      return 500;
  }
}

export function presentProcessResult(r: ProcessWagerTransactionResult) {
  return {
    transactionId: r.transactionId,
    status: r.status,
    balance: r.balance?.toJSON(),
    failureCode: r.failureCode,
    idempotentReplay: r.idempotentReplay,
  };
}

export function presentWallet(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    createdAt: e.createdAt.toISOString(),
  };
}

export function presentStoredTransaction(s: StoredWagerTransaction) {
  const t = s.transaction;
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    balance: s.resultingBalance?.toJSON(),
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}

export function presentReconciliation(r: ReconciliationResult) {
  return {
    walletId: r.walletId,
    storedBalance: r.storedBalance.toJSON(),
    calculatedBalance: r.calculatedBalance.toJSON(),
    difference: r.difference.toJSON(),
    consistent: r.consistent,
    checkedEntries: r.checkedEntries,
  };
}