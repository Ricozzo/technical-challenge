import { InvalidMoneyError, InvalidWalletError } from "../../domain/errors/domain-errors";
import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../domain/messaging/wager-events";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wager/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletAlreadyExistsError } from "../errors";
import type { UnitOfWork } from "../ports/repositories";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export class OpenWalletUseCase {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly deps: { uow: UnitOfWork; now?: () => Date; newId?: () => string },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => Bun.randomUUIDv7());
  }

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    if (typeof command.playerId !== "string" || command.playerId.trim() === "") {
      throw new InvalidWalletError("playerId is required");
    }
    if (typeof command.initialBalance !== "object" || command.initialBalance === null) {
      throw new InvalidMoneyError("initialBalance is required");
    }

    const initialBalance = Money.from(command.initialBalance);
    const at = this.now();
    const correlationId = command.correlationId ?? this.newId();
    const wallet = Wallet.open({
      id: this.newId(),
      playerId: command.playerId,
      initialBalance,
      now: at,
    });

    await this.deps.uow.run(async (repos) => {
      if (!(await repos.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(
          `Player ${wallet.playerId} already has a ${wallet.currency} wallet`,
        );
      }
      if (!initialBalance.isPositive()) return;

      const opening = WagerTransaction.createOpening({
        id: this.newId(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        now: at,
      });
      if (!(await repos.transactions.insertIfAbsent(opening))) {
        throw new Error(`Opening transaction of wallet ${wallet.id} already exists`);
      }

      const entry = WalletLedgerEntry.create({
        id: this.newId(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: initialBalance,
        createdAt: at,
      });
      await repos.ledger.append(entry);

      opening.markProcessed(undefined, at);
      await repos.transactions.save(opening, { resultingBalance: wallet.balance });

      await repos.outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            eventId: this.newId(),
            correlationId,
            occurredAt: at,
          }),
        ),
      );
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance,
      version: wallet.version,
    };
  }
}