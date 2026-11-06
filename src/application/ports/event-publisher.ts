import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Leva um evento da outbox para o broker. Lança erro se não conseguir. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}