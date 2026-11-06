import type { NextFunction, Request, Response } from "express";
import type { MetricsPort } from "../../application/ports/observability";

const CORRELATION_HEADER = "x-correlation-id";
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Garante um correlation id em toda requisição (aceita o do cliente, ou gera um), devolve-o no
 * cabeçalho da resposta e mede a latência por TEMPLATE de rota, para não explodir o número de séries.
 */
export function correlationAndMetrics(metrics: MetricsPort) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === "string" && VALID_CORRELATION_ID.test(incoming)
        ? incoming
        : Bun.randomUUIDv7();
    // Os controllers leem o cabeçalho da requisição, então ele passa a existir sempre.
    req.headers[CORRELATION_HEADER] = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);

    const startedAt = performance.now();
    res.on("finish", () => {
      metrics.observe("http_request_duration_seconds", (performance.now() - startedAt) / 1000, {
        method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
        status: String(res.statusCode),
      });
    });
    next();
  };
}