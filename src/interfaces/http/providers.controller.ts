import { Controller, Get, Inject, Param } from "@nestjs/common";
import { WagerQueries } from "../../application/use-cases/queries";
import { presentStoredTransaction } from "./presenters";

@Controller("providers/:providerId/wagering/transactions")
export class ProvidersController {
  constructor(@Inject(WagerQueries) private readonly queries: WagerQueries) {}

  @Get(":externalTransactionId")
  async get(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return presentStoredTransaction(
      await this.queries.getTransactionByExternalId(providerId, externalTransactionId),
    );
  }
}