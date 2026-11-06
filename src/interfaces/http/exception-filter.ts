import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import type { LoggerPort } from "../../application/ports/observability";
import { mapError } from "./http-errors";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      const error = exception as { name?: string; message?: string };
      this.logger.error("request_failed", {
        status: mapped.status,
        code: mapped.body.error.code,
        errorName: error?.name,
        errorMessage: error?.message,
      });
    }

    if (mapped.headers) response.set(mapped.headers);
    response.status(mapped.status).json(mapped.body);
  }
}