import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository } from "../../../application/ports/repositories";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { query } from "../db-helpers";

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(message: InboxMessage): Promise<boolean> {
    const rows = await query(
      this.em,
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows = await query(
      this.em,
      `select consumer_name, message_id, payload_hash, received_at, processed_at
         from inbox_messages where consumer_name = ? and message_id = ?`,
      [consumerName, messageId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return InboxMessage.rehydrate({
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      receivedAt: new Date(row.received_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
    });
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await query(
      this.em,
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
    );
  }
}