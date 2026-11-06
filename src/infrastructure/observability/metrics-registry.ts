import type { MetricsPort } from "../../application/ports/observability";

type Labels = Record<string, string>;

/** Em segundos: de 5 ms a 5 min. Serve para latências e para o lag da outbox. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300] as const;

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

const escapeLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const escapeHelp = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
}

const sample = (name: string, labels: string, value: number) =>
  labels === "" ? `${name} ${value}` : `${name}{${labels}} ${value}`;

const withLe = (labels: string, le: string) => (labels === "" ? `le="${le}"` : `${labels},le="${le}"`);

const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b));

export class MetricsRegistry implements MetricsPort {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();
  private readonly help = new Map<string, string>();
  private readonly collectors: Array<() => Promise<void> | void> = [];

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  registerCollector(collector: () => Promise<void> | void): void {
    this.collectors.push(collector);
  }

  async collect(timeoutMs = 2_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const all = Promise.allSettled(this.collectors.map(async (collector) => collector())).then(
      () => undefined,
    );
    try {
      await Promise.race([all, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  increment(name: string, labels: Labels = {}, value = 1): void {
    const key = labelKey(labels);
    const series = this.counters.get(name) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + value);
    this.counters.set(name, series);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(labelKey(labels), value);
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(labels);
    const series = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const entry = series.get(key) ?? {
      counts: Array.from({ length: BUCKETS.length }, () => 0),
      sum: 0,
      count: 0,
    };
    const index = BUCKETS.findIndex((bound) => value <= bound);
    if (index >= 0) entry.counts[index] = (entry.counts[index] ?? 0) + 1;
    entry.sum += value;
    entry.count += 1;
    series.set(key, entry);
    this.histograms.set(name, series);
  }

  // Testes
  valueOf(name: string, labels: Labels = {}): number | undefined {
    const key = labelKey(labels);
    return this.counters.get(name)?.get(key) ?? this.gauges.get(name)?.get(key);
  }
  // Testes
  histogram(name: string, labels: Labels = {}): { count: number; sum: number } | undefined {
    const entry = this.histograms.get(name)?.get(labelKey(labels));
    return entry ? { count: entry.count, sum: entry.sum } : undefined;
  }

  render(): string {
    const lines: string[] = [];
    const header = (name: string, type: string) => {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${escapeHelp(help)}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    for (const [name, series] of sorted(this.counters)) {
      header(name, "counter");
      for (const [labels, value] of series) lines.push(sample(name, labels, value));
    }

    for (const [name, series] of sorted(this.gauges)) {
      header(name, "gauge");
      for (const [labels, value] of series) lines.push(sample(name, labels, value));
    }

    for (const [name, series] of sorted(this.histograms)) {
      header(name, "histogram");
      for (const [labels, entry] of series) {
        let cumulative = 0;
        for (const [i, bound] of BUCKETS.entries()) {
          cumulative += entry.counts[i] ?? 0;
          lines.push(sample(`${name}_bucket`, withLe(labels, String(bound)), cumulative));
        }
        lines.push(sample(`${name}_bucket`, withLe(labels, "+Inf"), entry.count));
        lines.push(sample(`${name}_sum`, labels, entry.sum));
        lines.push(sample(`${name}_count`, labels, entry.count));
      }
    }

    return `${lines.join("\n")}\n`;
  }
}