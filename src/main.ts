import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { LoggerPort } from "./application/ports/observability";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { LOGGER } from "./tokens";

const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
configureApp(app);

const port = Number(process.env.PORT ?? 3000);
await app.listen(port, "0.0.0.0");
app.get<LoggerPort>(LOGGER).info("http_listening", { port });