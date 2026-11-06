import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";

describe("contadores e gauges", () => {
  test("os rótulos são ordenados e escapados", () => {
    const registry = new MetricsRegistry();
    registry.increment("jobs_total", { b: "2", a: 'x"y' });
    expect(registry.render()).toContain('jobs_total{a="x\\"y",b="2"} 1');
  });

  test("o contador acumula e o gauge sobrescreve", () => {
    const registry = new MetricsRegistry();
    registry.increment("c_total", { k: "v" });
    registry.increment("c_total", { k: "v" }, 2);
    registry.set("g", 5);
    registry.set("g", 3);
    expect(registry.valueOf("c_total", { k: "v" })).toBe(3);
    expect(registry.valueOf("g")).toBe(3);
  });

  test("HELP e TYPE aparecem para o que foi descrito", () => {
    const registry = new MetricsRegistry();
    registry.describe("jobs_total", "Jobs done.");
    registry.increment("jobs_total");
    registry.set("depth", 1);
    const text = registry.render();
    expect(text).toContain("# HELP jobs_total Jobs done.");
    expect(text).toContain("# TYPE jobs_total counter");
    expect(text).toContain("# TYPE depth gauge");
  });
});

describe("histograma", () => {
  test("os buckets são acumulados, com +Inf, soma e contagem", () => {
    const registry = new MetricsRegistry();
    for (const value of [0.003, 0.02, 0.7]) registry.observe("latency_seconds", value);

    const text = registry.render();
    expect(text).toContain("# TYPE latency_seconds histogram");
    expect(text).toContain('latency_seconds_bucket{le="0.005"} 1');
    expect(text).toContain('latency_seconds_bucket{le="0.025"} 2');
    expect(text).toContain('latency_seconds_bucket{le="1"} 3');
    expect(text).toContain('latency_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("latency_seconds_count 3");

    const h = registry.histogram("latency_seconds");
    expect(h?.count).toBe(3);
    expect(h?.sum).toBeCloseTo(0.723, 6);
  });

  test("com rótulos, o le vem depois deles", () => {
    const registry = new MetricsRegistry();
    registry.observe("http_seconds", 0.2, { route: "/x", method: "GET" });
    expect(registry.render()).toContain('http_seconds_bucket{method="GET",route="/x",le="0.25"} 1');
    expect(registry.render()).toContain('http_seconds_count{method="GET",route="/x"} 1');
  });

  test("valores inválidos são ignorados", () => {
    const registry = new MetricsRegistry();
    registry.observe("latency_seconds", Number.NaN);
    registry.observe("latency_seconds", -1);
    registry.observe("latency_seconds", Number.POSITIVE_INFINITY);
    expect(registry.histogram("latency_seconds")).toBeUndefined();
  });
});

describe("collectors", () => {
  test("rodam a cada collect, e um que falha não derruba os outros", async () => {
    const registry = new MetricsRegistry();
    let runs = 0;
    registry.registerCollector(() => {
      runs++;
    });
    registry.registerCollector(async () => {
      throw new Error("boom");
    });
    registry.registerCollector(async () => {
      registry.set("fresh", 1);
    });

    await registry.collect();
    await registry.collect();
    expect(runs).toBe(2);
    expect(registry.valueOf("fresh")).toBe(1);
  });

  test("um collector que não termina não trava o /metrics", async () => {
    const registry = new MetricsRegistry();
    registry.registerCollector(() => new Promise<void>(() => {}));

    const startedAt = performance.now();
    await registry.collect(50);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});