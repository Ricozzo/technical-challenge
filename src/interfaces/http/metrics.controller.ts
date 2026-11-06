import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MetricsRegistry } from "../../infrastructure/observability/metrics-registry";
import { METRICS } from "../../tokens";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsRegistry) {}

  @Get()
  async render(@Res() res: Response): Promise<void> {
    await this.metrics.collect();
    res.type("text/plain; version=0.0.4").send(this.metrics.render());
  }
}