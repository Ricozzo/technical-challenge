import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from "../errors/domain-errors";
import { LedgerDirection } from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance cannot be negative");
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `Balance ${this._balance.toString()} cannot cover ${props.money.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private apply(
    direction: LedgerDirection,
    props: MovementProps,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError("Movement amount must be positive");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency is ${this.currency}, operation is ${money.currency}`,
      );
    }
  }
}