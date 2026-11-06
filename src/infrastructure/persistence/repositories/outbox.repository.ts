import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository, OutboxStats } from "../../../application/ports/repositories";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { query, type Row } from "../db-helpers";

const MAX_ERROR_LENGTH = 500;

function toMessage(row: Row): OutboxMessage {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: payload as Record<string, unknown>,
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
  });
}

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

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await query(
      this.em,
      `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         from outbox_messages
        where published_at is null and (next_attempt_at is null or next_attempt_at <= ?)
        order by occurred_at, id
        limit ?
        for update skip locked`,
      [now, limit],
    );
    return rows.map(toMessage);
  }

  async save(message: OutboxMessage, opts: { error?: string } = {}): Promise<void> {
    const rows = await query(
      this.em,
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, published_at = ?,
              last_error = coalesce(?::text, last_error)
        where id = ?
        returning id`,
      [
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
        opts.error?.slice(0, MAX_ERROR_LENGTH) ?? null,
        message.id,
      ],
    );
    if (rows.length !== 1) throw new Error(`Outbox message ${message.id} was not found`);
  }
  async stats(): Promise<OutboxStats> {
    const rows = await query(
      this.em,
      `select count(*)::int as pending, min(occurred_at) as oldest
         from outbox_messages
        where published_at is null`,
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined,
    };
  }
}