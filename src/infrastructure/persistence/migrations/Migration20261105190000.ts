import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem aqui, no banco, e não apenas no código da aplicação.
 */
export class Migration20261105190000 extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency varchar(3) not null,
        balance numeric(19,2) not null,
        version integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$')
      )
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19,2) not null,
        currency varchar(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null default 'PENDING',
        failure_code text,
        resulting_balance numeric(19,2),
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null default now(),
        processed_at timestamptz,

        constraint wager_tx_provider_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_id_wallet_uq unique (id, wallet_id),

        constraint wager_tx_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency),
        constraint wager_tx_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id),

        constraint wager_tx_kind_valid check
          (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_tx_status_valid check
          (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_tx_amount_valid check (amount > 0 or kind = 'LOSS'),
        constraint wager_tx_reference_required check
          (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_bet_no_reference check
          (kind <> 'BET' or reference_external_transaction_id is null),
        constraint wager_tx_failure_code_consistent check
          ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_consistent check
          ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_processed_reversal_has_reference check
          (kind not in ('REFUND', 'ROLLBACK') or status <> 'PROCESSED' or reference_transaction_id is not null),
        constraint wager_tx_attempts_non_negative check (attempts >= 0),
        constraint wager_tx_resulting_balance_non_negative check
          (resulting_balance is null or resulting_balance >= 0)
      )
    `);

    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at)`);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK, o que vier primeiro).
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);

    // O worker de PENDING_REFERENCE só olha para as pendentes.
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    // ------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(19,2) not null,
        currency varchar(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null default now(),

        constraint ledger_seq_uq unique (seq),
        constraint ledger_wallet_transaction_uq unique (wallet_id, transaction_id),
        constraint ledger_wallet_fk foreign key (wallet_id, currency)
          references wallets (id, currency),
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id),

        constraint ledger_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )
    `);

    // seq dá um cursor estável e opaco para a paginação do ledger.
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq)`);

    // ----------------------------------------------------------- inbox / outbox
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null default now(),
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        last_error text,
        constraint outbox_attempts_non_negative check (attempts >= 0)
      )
    `);

    // Só as pendentes entram no índice, então ele fica pequeno mesmo com milhões de publicadas.
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (next_attempt_at nulls first, occurred_at)
        where published_at is null
    `);

    // ------------------------------------------------------------------ triggers
    this.addSql(`
      create function guard_ledger_immutable() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is immutable: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function guard_ledger_immutable()
    `);

    this.addSql(`
      create function guard_wager_transactions() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted'
            using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot be updated', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id) then
          raise exception 'identity columns of a wager transaction are immutable'
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function guard_wager_transactions()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists guard_ledger_immutable()`);
    this.addSql(`drop function if exists guard_wager_transactions()`);
  }
}