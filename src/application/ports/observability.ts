export interface LoggerPort {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): LoggerPort;
}

export interface MetricsPort {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
  set(name: string, value: number, labels?: Record<string, string>): void;
}

export const noopLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export const noopMetrics: MetricsPort = {
  increment: () => {},
  observe: () => {},
  set: () => {},
};