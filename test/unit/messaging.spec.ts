import { describe, expect, test } from "bun:test";
import { InvalidMessageStateError } from "../../src/domain/errors/domain-errors";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/messaging/wager-events";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");

function balanceChangedEvent() {
  const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), now: at });
  const entry = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("30.00"), at });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: "ev1",
    correlationId: "c1",
    occurredAt: at,
  });
}

describe("IntegrationEvent", () => {
  test("o envelope serializa o tipo, a versão e o dinheiro como string decimal", () => {
    const json = balanceChangedEvent().toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.aggregateId).toBe("w1");
    expect(json.data.money).toEqual({ amount: "30.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "70.00", currency: "BRL" });
    expect(json.data.walletVersion).toBe(2);
  });

  test("o payload é JSON estável: sobrevive a stringify e parse", () => {
    const json = balanceChangedEvent().toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("OutboxMessage", () => {
  test("nasce pendente e vencida, com o eventId como id", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    expect(message.id).toBe("ev1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  test("scheduleRetry usa backoff exponencial: 1s, 2s, 4s", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    const delays = [1_000, 2_000, 4_000];
    for (const [i, delay] of delays.entries()) {
      message.scheduleRetry(at);
      expect(message.attempts).toBe(i + 1);
      expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + delay);
    }
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 4_000))).toBe(true);
  });

  test("o backoff tem teto de 5 minutos", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    for (let i = 0; i < 30; i++) message.scheduleRetry(at);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 5 * 60 * 1_000);
  });

  test("markPublished encerra a mensagem; depois disso nada muda", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at)).toBe(false);
    expect(() => message.markPublished(at)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(at)).toThrow(InvalidMessageStateError);
  });
});

describe("InboxMessage", () => {
  test("receive, markProcessed e a comparação de payload", () => {
    const message = InboxMessage.receive({
      messageId: "m1",
      consumerName: "wager-consumer",
      payloadHash: "h1",
      now: at,
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.matchesPayload("h1")).toBe(true);
    expect(message.matchesPayload("h2")).toBe(false);

    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
  });

  test("processar duas vezes é erro de programação", () => {
    const message = InboxMessage.receive({ messageId: "m1", consumerName: "c", payloadHash: "h" });
    message.markProcessed(at);
    expect(() => message.markProcessed(at)).toThrow(InvalidMessageStateError);
  });
});