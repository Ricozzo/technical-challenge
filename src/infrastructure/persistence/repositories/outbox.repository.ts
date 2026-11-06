import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../../application/ports/repositories";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { query } from "../db-helpers";

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await query(
      this.em,
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, ?, ?::jsonb, ?, ?)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
      ],
    );
  }
}