import { describe, expect, test } from "bun:test";
import { IdempotencyConflictError, InvalidQueryError, TransactionNotFoundError, WalletAlreadyExistsError, WalletNotFoundError, ConcurrentModificationError } from "../../src/application/errors";
import { InsufficientFundsError, InvalidMoneyError, InvalidTransactionError } from "../../src/domain/errors/domain-errors";
import { mapError } from "../../src/interfaces/http/http-errors";
import { InvalidIdempotencyKeyError } from "../../src/interfaces/http/request-parsing";

describe("mapError", () => {
  test.each([
    [new InvalidMoneyError("x"), 400, "INVALID_MONEY"],
    [new InvalidTransactionError("x"), 400, "INVALID_TRANSACTION"],
    [new InvalidQueryError("x"), 400, "INVALID_QUERY"],
    [new InvalidIdempotencyKeyError("x"), 400, "INVALID_IDEMPOTENCY_KEY"],
    [new WalletNotFoundError("x"), 404, "WALLET_NOT_FOUND"],
    [new TransactionNotFoundError("x"), 404, "TRANSACTION_NOT_FOUND"],
    [new IdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
    [new WalletAlreadyExistsError("x"), 409, "WALLET_ALREADY_EXISTS"],
  ])("%p -> %d %s", (error, status, code) => {
    const mapped = mapError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.body.error.retryable).toBe(false);
  });

  test("conflito de concorrência é transitório: 503 com Retry-After", () => {
    const mapped = mapError(new ConcurrentModificationError("x"));
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.retryable).toBe(true);
    expect(mapped.headers?.["Retry-After"]).toBe("1");
  });

  test("erro de domínio que escapa sem tratamento é 500, sem vazar a mensagem", () => {
    const mapped = mapError(new InsufficientFundsError("saldo interno"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).not.toContain("saldo interno");
  });

  test("falhas de conexão com o banco são 503 e reenviáveis", () => {
    for (const error of [
      Object.assign(new Error("boom"), { code: "ECONNRESET" }),
      Object.assign(new Error("boom"), { code: "57P01" }),
      new Error("Connection terminated unexpectedly"),
      new Error("wrapper", { cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }) }),
    ]) {
      const mapped = mapError(error);
      expect(mapped.status).toBe(503);
      expect(mapped.body.error.retryable).toBe(true);
    }
  });

  test("erros 4xx do framework (JSON inválido, rota inexistente)", () => {
    expect(mapError({ getStatus: () => 400 }).body.error.code).toBe("INVALID_PAYLOAD");
    expect(mapError({ status: 400, type: "entity.parse.failed" }).status).toBe(400);
    expect(mapError({ getStatus: () => 404 }).body.error.code).toBe("NOT_FOUND");
  });

  test("erro desconhecido é 500 e não reenviável", () => {
    const mapped = mapError(new Error("bug"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.retryable).toBe(false);
  });
});