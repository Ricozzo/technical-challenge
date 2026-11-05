import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from "../../src/domain/errors/domain-errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");

const openWallet = (initial = "100.00") =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(initial), now: at });

const move = (id: string, amount: string) => ({
  entryId: `e-${id}`,
  transactionId: `t-${id}`,
  money: brl(amount),
  at,
});

describe("Wallet.open", () => {
  test("começa com version 1 e o saldo inicial", () => {
    const w = openWallet("1000.00");
    expect(w.version).toBe(1);
    expect(w.balance.toJSON().amount).toBe("1000.00");
    expect(w.currency).toBe("BRL");
  });

  test("aceita saldo inicial zero", () => {
    expect(openWallet("0.00").balance.isZero()).toBe(true);
  });
});

describe("debit", () => {
  test("reduz o saldo, incrementa a version e devolve o lançamento", () => {
    const w = openWallet("100.00");
    const entry = w.debit(move("1", "30.00"));
    expect(w.balance.toJSON().amount).toBe("70.00");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("70.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("permite zerar o saldo exatamente", () => {
    const w = openWallet("80.00");
    w.debit(move("1", "80.00"));
    expect(w.balance.isZero()).toBe(true);
  });

  test("rejeita saldo insuficiente sem alterar nada", () => {
    const w = openWallet("50.00");
    expect(() => w.debit(move("1", "50.01"))).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe("50.00");
    expect(w.version).toBe(1);
  });

  test("cenário da seção 8: 100 com duas apostas de 80 -> só uma passa", () => {
    const w = openWallet("100.00");
    w.debit(move("1", "80.00"));
    expect(() => w.debit(move("2", "80.00"))).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe("20.00");
  });
});

describe("credit", () => {
  test("aumenta o saldo e gera lançamento CREDIT", () => {
    const w = openWallet("10.00");
    const entry = w.credit(move("1", "15.50"));
    expect(w.balance.toJSON().amount).toBe("25.50");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe("validações", () => {
  test("moeda diferente lança erro de domínio e não altera o estado", () => {
    const w = openWallet();
    const usd = { ...move("1", "10.00"), money: Money.from({ amount: "10.00", currency: "USD" }) };
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test("valor zero é rejeitado", () => {
    const w = openWallet();
    expect(() => w.debit(move("1", "0.00"))).toThrow(InvalidLedgerEntryError);
    expect(() => w.credit(move("2", "0.00"))).toThrow(InvalidLedgerEntryError);
    expect(w.version).toBe(1);
  });
});

describe("invariante saldo == ledger", () => {
  test("o saldo final é o inicial somado aos lançamentos", () => {
    const w = openWallet("100.00");
    const entries = [
      w.debit(move("1", "25.00")),
      w.credit(move("2", "10.00")),
      w.debit(move("3", "5.50")),
    ];
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      brl("100.00"),
    );
    expect(w.balance.equals(rebuilt)).toBe(true);
    expect(w.version).toBe(4);
  });
});

describe("rehydrate", () => {
  test("reconstrói o estado persistido sem alterá-lo", () => {
    const w = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe("42.00");
  });
});