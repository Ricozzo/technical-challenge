import type { LoggerPort } from "../../application/ports/observability";
import type { PublishOutboxUseCase } from "../../application/use-cases/publish-outbox";

export class OutboxPublisherWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  private readonly idleDelayMs: number;
  private readonly errorDelayMs: number;

  constructor(
    private readonly deps: {
      useCase: PublishOutboxUseCase;
      logger: LoggerPort;
      idleDelayMs?: number;
      errorDelayMs?: number;
    },
  ) {
    this.idleDelayMs = deps.idleDelayMs ?? 500;
    this.errorDelayMs = deps.errorDelayMs ?? 1_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.deps.logger.info("outbox_publisher_started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.deps.logger.info("outbox_publisher_stopped");
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.idleDelayMs;
      try {
        const result = await this.deps.useCase.execute();
        if (result.claimed > 0 && result.failed === 0) delay = 0;
      } catch (error) {
        // Banco indisponível, por exemplo. O worker continua vivo e tenta de novo.
        this.deps.logger.error("outbox_publisher_iteration_failed", {
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