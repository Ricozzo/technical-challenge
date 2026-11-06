import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

const SEND_TIMEOUT_MS = 5_000;

/** Publica o envelope do evento numa fila SQS FIFO. */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
        },
      }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
  }
}