import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/errors/domain-errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test("aceita decimal válido e serializa com 2 casas", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25").toJSON().amount).toBe("25.00");
    expect(brl("25.5").toJSON().amount).toBe("25.50");
    expect(brl("0").toJSON().amount).toBe("0.00");
  });

  test.each(["", "NaN", "Infinity", "-Infinity", "1e3", "1E3", "-5.00", "1.234", "abc", " 5", "5 ", "1,50", ".5", "5."])(
    "rejeita amount inválido: %p",
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test("rejeita amount que não é string", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["", "br", "BRLL", "brl", "123"])("rejeita currency inválida: %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("aritmética", () => {
  test("é exata, sem erro de ponto flutuante", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("1000000000000000.01").add(brl("0.01")).toJSON().amount).toBe("1000000000000000.02");
  });

  test("subtract pode produzir valor negativo", () => {
    const result = brl("10.00").subtract(brl("30.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-20.00");
  });

  test("negate inverte o sinal", () => {
    expect(brl("5.00").negate().toJSON().amount).toBe("-5.00");
    expect(brl("5.00").negate().negate().equals(brl("5.00"))).toBe(true);
  });

  test("é imutável: operações retornam nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toJSON().amount).toBe("10.00");
    expect(b.toJSON().amount).toBe("15.00");
    expect(b).not.toBe(a);
  });
});

describe("consultas", () => {
  test("isZero, isPositive, isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("1.00").subtract(brl("2.00")).isNegative()).toBe(true);
  });

  test("isLessThan e equals", () => {
    expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
    expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
    expect(brl("10").equals(brl("10.00"))).toBe(true);
  });

  test("equals é false para moedas diferentes", () => {
    const usd = Money.from({ amount: "10.00", currency: "USD" });
    expect(brl("10.00").equals(usd)).toBe(false);
  });
});

describe("conflito de moeda", () => {
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  test("add, subtract e isLessThan lançam erro de domínio", () => {
    expect(() => brl("10.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("10.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("10.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe("serialização", () => {
  test("toString inclui a moeda", () => {
    expect(brl("25").toString()).toBe("25.00 BRL");
  });

  test("JSON.stringify usa toJSON", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});