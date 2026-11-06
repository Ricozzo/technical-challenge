import type { INestApplication } from "@nestjs/common";
import type { LoggerPort } from "./application/ports/observability";
import { AllExceptionsFilter } from "./interfaces/http/exception-filter";
import { LOGGER } from "./tokens";

/** Configuração compartilhada entre a aplicação real e os testes. */
export function configureApp(app: INestApplication, opts: { shutdownHooks?: boolean } = {}): void {
  app.useGlobalFilters(new AllExceptionsFilter(app.get<LoggerPort>(LOGGER)));
  if (opts.shutdownHooks ?? true) app.enableShutdownHooks();
}