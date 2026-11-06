import { describe, expect, test } from "bun:test";
import { ConcurrentModificationError } from "../../src/application/errors";
import { classifyLockConflict } from "../../src/application/lock-conflicts";

describe("classifyLockConflict", () => {
  test("version mismatch do lock otimista", () => {
    expect(classifyLockConflict(new ConcurrentModificationError("stale"))).toBe("version_mismatch");
  });

  test.each([
    ["40P01", "deadlock"],
    ["40001", "serialization_failure"],
    ["55P03", "lock_timeout"],
  ])("SQLSTATE %s é %s", (code, reason) => {
    expect(classifyLockConflict(Object.assign(new Error("x"), { code }))).toBe(reason);
  });

  test("reconhece o erro embrulhado por outro", () => {
    const inner = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    expect(classifyLockConflict(new Error("wrapper", { cause: inner }))).toBe("deadlock");
  });

  test("erros que não são de concorrência não são conflito", () => {
    expect(classifyLockConflict(new Error("boom"))).toBeUndefined();
    expect(classifyLockConflict(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeUndefined();
    expect(classifyLockConflict(undefined)).toBeUndefined();
    expect(classifyLockConflict("texto")).toBeUndefined();
  });
});