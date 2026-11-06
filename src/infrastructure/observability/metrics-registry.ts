import type { MetricsPort } from "../../application/ports/observability";

const escapeLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export class MetricsRegistry implements MetricsPort {
  private readonly counters = new Map<string, Map<string, number>>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",");
    const series = this.counters.get(name) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + value);
    this.counters.set(name, series);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of series) {
        lines.push(labels === "" ? `${name} ${value}` : `${name}{${labels}} ${value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}