import { Controller, Get, Inject, Res } from "@nestjs/common";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Response } from "express";
import { ORM, SQS_CLIENT } from "../../tokens";

const PROBE_TIMEOUT_MS = 2_000;

/** Os endpoints de health ficam abertos, sem autenticação. */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Pronto para tráfego: PostgreSQL e SQS alcançáveis. */
  @Get("ready")
  async ready(@Res() res: Response): Promise<void> {
    const [postgres, sqs] = await Promise.all([
      this.probe(() => this.orm.em.fork().execute("select 1")),
      this.probe((signal) =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: process.env.SQS_WAGER_QUEUE_URL,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: signal },
        ),
      ),
    ]);
    const ok = postgres && sqs;
    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "unavailable",
      checks: { postgres: postgres ? "up" : "down", sqs: sqs ? "up" : "down" },
    });
  }

  private async probe(run: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("probe timeout")));
    });
    try {
      await Promise.race([run(controller.signal), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}