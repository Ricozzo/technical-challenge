import Decimal from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../errors/domain-errors";

// Cópia isolada do Decimal, para não depender de configuração global.
const D = Decimal.clone({ precision: 40 });

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

// Só dígitos, com até 2 casas. Recusa: vazio, "NaN", "Infinity", "1e3", "-5", "1.234".
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Porta de entrada para dados externos (API, fila). Rejeita valores negativos. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid amount: expected a non-negative decimal string with up to 2 decimal places`,
      );
    }
    if (typeof props.currency !== "string" || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid currency: expected ISO-4217 code such as "BRL"`);
    }
    return new Money(new D(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  /** Uso interno: o resultado de uma operação pode ser negativo (ex.: 10 - 30). */
  private static of(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}