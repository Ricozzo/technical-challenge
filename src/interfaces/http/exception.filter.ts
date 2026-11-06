import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { LoggerPort } from "../../application/ports/observability";
import { mapError } from "./http-errors";

const MAX_ERROR_MESSAGE = 200;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      const error = exception as { name?: string; message?: string } | null;
      this.logger.error("request_failed", {
        correlationId: request.headers["x-correlation-id"],
        method: request.method,
        route: typeof request.route?.path === "string" ? request.route.path : undefined,
        status: mapped.status,
        code: mapped.body.error.code,
        errorName: error?.name,
        errorMessage: String(error?.message ?? "").slice(0, MAX_ERROR_MESSAGE),
      });
    }

    if (mapped.headers) response.set(mapped.headers);
    response.status(mapped.status).json(mapped.body);
  }
}