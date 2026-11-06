import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";

export type Row = Record<string, any>;

export async function query(em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await em.execute(sql, params)) as unknown as Row[];
}

/**
 * Colunas numeric chegam como TEXT (`col::text`), nunca como number.
 * Aceita negativo porque um saldo reconstruído de um ledger corrompido pode ser negativo.
 */
export function moneyFromDb(amount: string, currency: string): Money {
  const negative = amount.startsWith("-");
  const money = Money.from({ amount: negative ? amount.slice(1) : amount, currency });
  return negative ? money.negate() : money;
}