import type { INestApplication } from "@nestjs/common";
import type { LoggerPort, MetricsPort } from "./application/ports/observability";
import { AllExceptionsFilter } from "./interfaces/http/exception.filter";
import { correlationAndMetrics } from "./interfaces/http/observability.middleware";
import { LOGGER, METRICS } from "./tokens";

/** Configuração compartilhada entre a aplicação real e os testes. */
export function configureApp(app: INestApplication, opts: { shutdownHooks?: boolean } = {}): void {
  app.use(correlationAndMetrics(app.get<MetricsPort>(METRICS)));
  app.useGlobalFilters(new AllExceptionsFilter(app.get<LoggerPort>(LOGGER)));
  if (opts.shutdownHooks ?? true) app.enableShutdownHooks();
}