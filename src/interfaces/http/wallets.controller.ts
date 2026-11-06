import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { MoneyProps } from "../../domain/money/money";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet";
import { WagerQueries } from "../../application/use-cases/queries";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet";
import {
  presentLedgerEntry,
  presentReconciliation,
  presentWallet,
} from "./presenters";
import { asRecord } from "./request-parsing";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    const input = asRecord(body);
    const wallet = await this.openWallet.execute({
      playerId: input.playerId as string,
      initialBalance: input.initialBalance as MoneyProps,
      correlationId,
    });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const page = await this.queries.listLedger(walletId, { cursor, limit });
    return { items: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param("walletId") walletId: string) {
    return presentReconciliation(await this.reconcile.execute(walletId));
  }
}