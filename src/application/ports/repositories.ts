import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  resultingBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export interface WalletRepository {
  /** false se já existe uma wallet para o player + moeda. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: quem chega depois espera.*/
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false se a idempotência já foi registrada. */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<StoredWagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, key: string): Promise<StoredWagerTransaction | undefined>;
  findByExternalId(providerId: string, externalId: string): Promise<StoredWagerTransaction | undefined>;
  existsProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;

  save(
    tx: WagerTransaction,
    opts?: {
      resultingBalance?: Money;
      retry?: { attempts: number; nextAttemptAt: Date | null };
    },
  ): Promise<void>;
  listDuePendingReference(now: Date, limit: number): Promise<DuePendingReference[]>;
  findByIdForUpdate(id: string): Promise<StoredWagerTransaction | undefined>;
}

export interface ReconciliationSnapshot {
  stored: Money;
  calculated: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  reconstructBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
  listPage(walletId: string, opts: { before?: string; limit: number }): Promise<LedgerPage>;
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  receive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestOccurredAt?: Date;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage, opts?: { error?: string }): Promise<void>;
  stats(): Promise<OutboxStats>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface LedgerPage {
  items: Array<{ seq: string; entry: WalletLedgerEntry }>;
  hasMore: boolean;
}