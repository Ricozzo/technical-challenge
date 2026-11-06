export interface LoggerPort {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): LoggerPort;
}

export interface MetricsPort {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
}