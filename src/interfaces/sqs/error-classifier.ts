import { DomainError } from "../../domain/errors/domain-errors";

export type ErrorClass = "business" | "permanent" | "transient";

const BUSINESS_CODES = new Set(["IDEMPOTENCY_CONFLICT"]);

const TRANSIENT_DOMAIN_CODES = new Set(["CONCURRENT_MODIFICATION"]);

/**
 * - business: ack. O resultado correto já existe, ou a mensagem não pode mudar nada.
 * - permanent: DLQ imediata. A mensagem em si está errada, e repetir não adianta.
 * - transient: retry com backoff e, esgotado o limite, DLQ. Inclui qualquer erro desconhecido:
 *   é mais seguro tentar de novo algumas vezes do que descartar uma operação financeira.
 */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof DomainError) {
    if (BUSINESS_CODES.has(error.code)) return "business";
    if (TRANSIENT_DOMAIN_CODES.has(error.code)) return "transient";
    return "permanent";
  }
  return "transient";
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return (error as { name?: string } | null)?.name ?? "UnknownError";
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}