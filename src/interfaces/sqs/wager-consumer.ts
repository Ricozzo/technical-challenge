import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { LoggerPort, MetricsPort } from "../../application/ports/observability";
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from "../../application/use-cases/process-wager-transaction";
import { classifyError, describeError, errorCode } from "./error-classifier";
import { parseWagerMessage } from "./wager-message";

export const DEFAULT_CONSUMER_NAME = "wager-transactions-consumer";

export interface WagerMessageProcessor {
  execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult>;
}

export interface WagerConsumerOptions {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  processor: WagerMessageProcessor;
  logger: LoggerPort;
  metrics: MetricsPort;
  consumerName?: string;
  maxAttempts?: number;
  batchSize?: number;
  waitTimeSeconds?: number;
  retryBaseDelaySeconds?: number;
  retryMaxDelaySeconds?: number;
  errorDelayMs?: number;
}

type Outcome = "done" | "retry";

const stringAttribute = (value: string) => ({
  DataType: "String" as const,
  StringValue: value === "" ? "n/a" : value,
});

export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private pollAbort: AbortController | undefined;
  private wake: (() => void) | undefined;

  private readonly consumerName: string;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly waitTimeSeconds: number;
  private readonly retryBaseDelaySeconds: number;
  private readonly retryMaxDelaySeconds: number;
  private readonly errorDelayMs: number;

  constructor(private readonly deps: WagerConsumerOptions) {
    this.consumerName = deps.consumerName ?? DEFAULT_CONSUMER_NAME;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.batchSize = deps.batchSize ?? 10;
    this.waitTimeSeconds = deps.waitTimeSeconds ?? 20;
    this.retryBaseDelaySeconds = deps.retryBaseDelaySeconds ?? 2;
    this.retryMaxDelaySeconds = deps.retryMaxDelaySeconds ?? 60;
    this.errorDelayMs = deps.errorDelayMs ?? 1_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.deps.logger.info("wager_consumer_started", { consumerName: this.consumerName });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.pollAbort?.abort();
    this.wake?.();
    await this.loop;
    this.deps.logger.info("wager_consumer_stopped", { consumerName: this.consumerName });
  }

  // Laço

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (!this.running) return;
        this.deps.logger.error("sqs_receive_failed", { error: describeError(error) });
        await this.sleep(this.errorDelayMs);
        continue;
      }
      if (messages.length === 0) continue;

      try {
        await this.handleBatch(messages);
      } catch (error) {
        this.deps.logger.error("wager_consumer_batch_failed", { error: describeError(error) });
      }
    }
  }

  private async receive(): Promise<Message[]> {
    const abort = new AbortController();
    this.pollAbort = abort;
    const response = await this.deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.deps.queueUrl,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: abort.signal },
    );
    return response.Messages ?? [];
  }

  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      const list = groups.get(key);
      if (list) list.push(message);
      else groups.set(key, [message]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
  }

  private async handleGroup(group: Message[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (!this.running) {
        await this.release(group.slice(index));
        return;
      }
      if ((await this.handleMessage(message)) === "retry") {
        await this.release(group.slice(index + 1));
        return;
      }
    }
  }

  // Mensagem

  private async handleMessage(message: Message): Promise<Outcome> {
    const startedAt = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let log = this.deps.logger.child({ sqsMessageId: message.MessageId, receiveCount });
    this.deps.metrics.increment("sqs_messages_received_total");

    let result: ProcessWagerTransactionResult;
    try {
      const parsed = parseWagerMessage(message.Body);
      log = log.child({
        messageId: parsed.messageId,
        correlationId: parsed.messageId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
      });
      result = await this.deps.processor.execute({
        ...parsed.command,
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        inbox: { consumerName: this.consumerName, messageId: parsed.messageId },
      });
    } catch (error) {
      return this.handleFailure(message, error, receiveCount, log);
    }

    if (!(await this.ack(message, log))) return "retry";

    this.deps.metrics.increment("sqs_messages_processed_total", {
      outcome: result.status.toLowerCase(),
    });
    log.debug("message_processed", {
      transactionId: result.transactionId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return "done";
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    receiveCount: number,
    log: LoggerPort,
  ): Promise<Outcome> {
    const kind = classifyError(error);

    if (kind === "business") {
      log.warn("message_business_error", { code: errorCode(error), error: describeError(error) });
      if (!(await this.ack(message, log))) return "retry";
      this.deps.metrics.increment("sqs_messages_processed_total", { outcome: "business_error" });
      return "done";
    }

    if (kind === "permanent") {
      return this.deadLetter(message, "permanent", error, receiveCount, log);
    }
    if (receiveCount >= this.maxAttempts) {
      return this.deadLetter(message, "retries_exhausted", error, receiveCount, log);
    }
    return this.scheduleRetry(message, error, receiveCount, log);
  }

  // Ack, retry, DLQ

  private async ack(message: Message, log: LoggerPort): Promise<boolean> {
    try {
      await this.deps.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      return true;
    } catch (error) {
      log.error("message_ack_failed", { error: describeError(error) });
      return false;
    }
  }

  private async scheduleRetry(
    message: Message,
    error: unknown,
    receiveCount: number,
    log: LoggerPort,
  ): Promise<Outcome> {
    const delay = Math.min(
      this.retryBaseDelaySeconds * 2 ** (receiveCount - 1),
      this.retryMaxDelaySeconds,
    );
    try {
      await this.deps.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
      );
    } catch (visibilityError) {
      log.warn("message_retry_scheduling_failed", { error: describeError(visibilityError) });
    }
    this.deps.metrics.increment("sqs_message_retries_total");
    log.warn("message_retry_scheduled", {
      code: errorCode(error),
      attempt: receiveCount,
      maxAttempts: this.maxAttempts,
      retryInSeconds: delay,
    });
    return "retry";
  }

  private async deadLetter(
    message: Message,
    reason: "permanent" | "retries_exhausted",
    error: unknown,
    receiveCount: number,
    log: LoggerPort,
  ): Promise<Outcome> {
    try {
      await this.deps.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.deps.dlqUrl,
          MessageBody: message.Body || "(empty)",
          MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
          MessageDeduplicationId: message.MessageId ?? Bun.randomUUIDv7(),
          MessageAttributes: {
            failureReason: stringAttribute(reason),
            errorCode: stringAttribute(errorCode(error)),
            errorMessage: stringAttribute(describeError(error).slice(0, 256)),
            receiveCount: stringAttribute(String(receiveCount)),
            sourceMessageId: stringAttribute(message.MessageId ?? "unknown"),
          },
        }),
      );
    } catch (sendError) {
      log.error("message_dead_letter_failed", { error: describeError(sendError) });
      return "retry";
    }

    if (!(await this.ack(message, log))) return "retry";
    this.deps.metrics.increment("sqs_messages_dead_lettered_total", { reason });
    log.error("message_dead_lettered", { reason, code: errorCode(error), receiveCount });
    return "done";
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.deps.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.deps.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch(() => undefined),
      ),
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}