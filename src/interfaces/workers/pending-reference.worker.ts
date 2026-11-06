import type { LoggerPort } from "../../application/ports/observability";
import type { RetryPendingReferencesUseCase } from "../../application/use-cases/retry-pending-references";

/**
 * Laço agendado que chama o caso de uso. Enquanto o lote vem cheio, repete na hora.
 * Sem trabalho vencido, espera. O stop() deixa a rodada em andamento terminar antes de devolver.
 */
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  private readonly idleDelayMs: number;
  private readonly errorDelayMs: number;

  constructor(
    private readonly deps: {
      useCase: RetryPendingReferencesUseCase;
      logger: LoggerPort;
      idleDelayMs?: number;
      errorDelayMs?: number;
    },
  ) {
    this.idleDelayMs = deps.idleDelayMs ?? 1_000;
    this.errorDelayMs = deps.errorDelayMs ?? 1_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.deps.logger.info("pending_reference_worker_started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.deps.logger.info("pending_reference_worker_stopped");
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.idleDelayMs;
      try {
        const result = await this.deps.useCase.execute();
        if (result.due >= this.deps.useCase.batchSize) delay = 0;
      } catch (error) {
        // Banco indisponível, por exemplo. O worker continua vivo e tenta de novo.
        this.deps.logger.error("pending_reference_iteration_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        delay = this.errorDelayMs;
      }
      if (this.running && delay > 0) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}