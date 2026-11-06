import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction";
import { DomainError } from "../../domain/errors/domain-errors";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

/**  Se a mensagem não estiver no formato esperado, reenviar a mesma mensagem nunca vai funcionar. */
export class MalformedMessageError extends DomainError {
  readonly code = "MALFORMED_MESSAGE";
}

export type WagerMessageCommand = Omit<
  ProcessWagerTransactionCommand,
  "inbox" | "causationId" | "correlationId"
>;

export interface ParsedWagerMessage {
  messageId: string;
  command: WagerMessageCommand;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Valida só o envelope. Os campos do payload são validados pelo caso de uso, o mesmo do HTTP,
 * então as duas entradas aplicam exatamente as mesmas regras.
 */
export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  if (body === undefined || body.trim() === "") {
    throw new MalformedMessageError("Message body is empty");
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedMessageError("Message body is not valid JSON");
  }

  const envelope = asRecord(json);
  const messageId = envelope.messageId;
  if (typeof messageId !== "string" || messageId.trim() === "") {
    throw new MalformedMessageError("messageId is required");
  }
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw new MalformedMessageError(`Unsupported message type, expected ${WAGER_MESSAGE_TYPE}`);
  }
  const data = asRecord(envelope.data);
  if (Object.keys(data).length === 0) {
    throw new MalformedMessageError("data is required");
  }

  return {
    messageId,
    command: {
      idempotencyKey: data.idempotencyKey as string,
      providerId: data.providerId as string,
      externalTransactionId: data.externalTransactionId as string,
      playerId: data.playerId as string,
      walletId: data.walletId as string,
      roundId: data.roundId as string,
      gameId: data.gameId as string,
      kind: data.kind as string,
      money: data.money as ProcessWagerTransactionCommand["money"],
      referenceExternalTransactionId: data.referenceExternalTransactionId as string | undefined,
    },
  };
}