export interface MetricDefinition {
  name: string;
  type: "counter" | "gauge" | "histogram";
  help: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: "wager_transactions_total",
    type: "counter",
    help: "Transactions that reached a decision, by kind, status (PROCESSED, REJECTED, PENDING_REFERENCE, FAILED) and source (http, sqs, pending_reference_worker).",
  },
  {
    name: "duplicates_detected_total",
    type: "counter",
    help: "Requests recognized as idempotent replays, by entry point (http, sqs).",
  },
  {
    name: "idempotency_conflicts_total",
    type: "counter",
    help: "Requests that reused an idempotency key with a different payload.",
  },
  {
    name: "wager_processing_duration_seconds",
    type: "histogram",
    help: "End-to-end time to process a transaction, by source and outcome (processed, rejected, pending_reference, error).",
  },
  {
    name: "lock_conflicts_total",
    type: "counter",
    help: "Concurrency failures, by reason (version_mismatch, deadlock, serialization_failure, lock_timeout).",
  },
  {
    name: "wallet_lock_wait_seconds",
    type: "histogram",
    help: "Time spent waiting for the wallet row lock. A long tail means a hot wallet.",
  },
  {
    name: "outbox_pending_events",
    type: "gauge",
    help: "Events waiting in the outbox. Global (read from the database), so aggregate across instances with max, not sum.",
  },
  {
    name: "outbox_oldest_pending_age_seconds",
    type: "gauge",
    help: "Age of the oldest unpublished outbox event (the outbox lag). Global: aggregate across instances with max.",
  },
  {
    name: "outbox_publish_lag_seconds",
    type: "histogram",
    help: "Time between an event occurring and its publication to the broker, by event type.",
  },
  {
    name: "outbox_events_published_total",
    type: "counter",
    help: "Outbox events published, by event type.",
  },
  {
    name: "outbox_publish_failures_total",
    type: "counter",
    help: "Failed outbox publications (each one is retried with backoff), by event type.",
  },
  { name: "sqs_messages_received_total", type: "counter", help: "Messages received from the transactions queue." },
  {
    name: "sqs_messages_processed_total",
    type: "counter",
    help: "Messages acknowledged, by outcome (processed, rejected, pending_reference, business_error).",
  },
  {
    name: "sqs_message_retries_total",
    type: "counter",
    help: "Messages scheduled for another attempt after a transient error.",
  },
  {
    name: "sqs_messages_dead_lettered_total",
    type: "counter",
    help: "Messages sent to the dead-letter queue, by reason (permanent, retries_exhausted).",
  },
  {
    name: "pending_reference_retries_total",
    type: "counter",
    help: "Reevaluations of PENDING_REFERENCE transactions, by outcome (processed, rejected, waiting, expired, failed, error).",
  },
  {
    name: "wallet_reconciliations_total",
    type: "counter",
    help: "Reconciliations run, by result (consistent, divergent).",
  },
  {
    name: "wallet_reconciliation_divergences_total",
    type: "counter",
    help: "Reconciliations where the stored balance differed from the ledger.",
  },
  {
    name: "http_request_duration_seconds",
    type: "histogram",
    help: "HTTP request duration, by method, route template and status.",
  },
];

export function describeMetrics(registry: { describe(name: string, help: string): void }): void {
  for (const definition of METRIC_DEFINITIONS) registry.describe(definition.name, definition.help);
}