import { DomainError } from "../../domain/errors/domain-errors";

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_MONEY: 400,
  INVALID_TRANSACTION: 400,
  INVALID_WALLET: 400,
  INVALID_QUERY: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  CONCURRENT_MODIFICATION: 503,
};

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "57P01", "57P02", "57P03", // banco desligando ou reiniciando
  "53300", // too many connections
  "40001", "40P01", // falha de serialização, deadlock
  "08000", "08003", "08006", // exceções de conexão
]);
const TRANSIENT_NAMES = new Set(["ConnectionException", "DeadlockException", "LockWaitTimeoutException"]);
const TRANSIENT_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|connection refused|connection error/i;

const SERVICE_UNAVAILABLE_MESSAGE =
  "Temporary failure. Retry with the same Idempotency-Key";

function build(
  status: number,
  code: string,
  message: string,
  retryable = false,
  headers?: Record<string, string>,
): MappedError {
  return { status, body: { error: { code, message, retryable } }, ...(headers && { headers }) };
}

const serviceUnavailable = (code: string) =>
  build(503, code, SERVICE_UNAVAILABLE_MESSAGE, true, { "Retry-After": "1" });

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function isTransientInfrastructureError(err: unknown): boolean {
  return causeChain(err).some((item) => {
    const { code, name, message } = item as { code?: unknown; name?: unknown; message?: unknown };
    return (
      (typeof code === "string" && TRANSIENT_CODES.has(code)) ||
      (typeof name === "string" && TRANSIENT_NAMES.has(name)) ||
      (typeof message === "string" && TRANSIENT_MESSAGE.test(message))
    );
  });
}

function clientErrorStatus(err: unknown): number | undefined {
  const e = err as { getStatus?: () => number; status?: unknown; statusCode?: unknown } | null;
  const candidate =
    typeof e?.getStatus === "function"
      ? e.getStatus()
      : typeof e?.status === "number"
        ? e.status
        : typeof e?.statusCode === "number"
          ? e.statusCode
          : undefined;
  return candidate !== undefined && candidate >= 400 && candidate < 500 ? candidate : undefined;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof DomainError) {
    const status = STATUS_BY_CODE[err.code];
    if (status === 503) return serviceUnavailable(err.code);
    if (status !== undefined) return build(status, err.code, err.message);
    return build(500, "INTERNAL_ERROR", "Unexpected error");
  }

  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    switch (clientStatus) {
      case 400: return build(400, "INVALID_PAYLOAD", "Request body is not valid JSON or has an unsupported format");
      case 404: return build(404, "NOT_FOUND", "Route not found");
      case 413: return build(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
      case 415: return build(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json");
      default: return build(clientStatus, "REQUEST_ERROR", "The request could not be processed");
    }
  }

  if (isTransientInfrastructureError(err)) return serviceUnavailable("SERVICE_UNAVAILABLE");

  return build(500, "INTERNAL_ERROR", "Unexpected error");
}