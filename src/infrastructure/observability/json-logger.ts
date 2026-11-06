import type { LoggerPort } from "../../application/ports/observability";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export class JsonLogger implements LoggerPort {
  private readonly min: number;

  constructor(
    private readonly base: Record<string, unknown> = {},
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly levelName: string = process.env.LOG_LEVEL ?? "info",
  ) {
    this.min = LEVELS[levelName as Level] ?? LEVELS.info;
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }

  child(fields: Record<string, unknown>): LoggerPort {
    return new JsonLogger({ ...this.base, ...fields }, this.write, this.levelName);
  }

  private log(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.min) return;
    this.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...this.base, ...fields }));
  }
}