import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { InvalidLedgerEntryError } from "../../src/domain/errors/domain-errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const base = {
  id: "e1",
  walletId: "w1",
  transactionId: "t1",
  direction: LedgerDirection.Debit,
  money: brl("30.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("70.00"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("WalletLedgerEntry.create", () => {
  test("aceita um lançamento com a aritmética correta", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test("aceita crédito correto", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      balanceAfter: brl("130.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("rejeita aritmética incorreta", () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("71.00") })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejeita direção que não bate com os saldos", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("100.00") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita saldo final negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl("150.00"),
        balanceAfter: brl("100.00").subtract(brl("150.00")),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("não revalida, e isBalanced denuncia dado corrompido", () => {
    const corrupted = WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl("1.00") });
    expect(corrupted.isBalanced()).toBe(false);
  });
});