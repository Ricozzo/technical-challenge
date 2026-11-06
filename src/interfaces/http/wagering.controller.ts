import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MoneyProps } from "../../domain/money/money";
import { WagerQueries } from "../../application/use-cases/queries";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction";
import { httpStatusFor, presentProcessResult, presentStoredTransaction } from "./presenters";
import { asRecord, parseIdempotencyKey } from "./request-parsing";

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTx: ProcessWagerTransactionUseCase,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) {}

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const key = parseIdempotencyKey(idempotencyKey);
    const input = asRecord(body);

    const result = await this.processTx.execute({
      idempotencyKey: key,
      providerId: input.providerId as string,
      externalTransactionId: input.externalTransactionId as string,
      playerId: input.playerId as string,
      walletId: input.walletId as string,
      roundId: input.roundId as string,
      gameId: input.gameId as string,
      kind: input.kind as string,
      money: input.money as MoneyProps,
      referenceExternalTransactionId: input.referenceExternalTransactionId as string | undefined,
      correlationId,
    });

    res.status(httpStatusFor(result.status)).json(presentProcessResult(result));
  }

  @Get(":transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return presentStoredTransaction(await this.queries.getTransactionById(transactionId));
  }
}