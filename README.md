# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos, por HTTP e por SQS.

O sistema continua correto quando as mensagens chegam duplicadas, fora de ordem ou em paralelo, e com várias instâncias rodando ao mesmo tempo. As garantias de dinheiro (saldo nunca negativo, ledger imutável, idempotência, reversão única) são aplicadas **no schema do banco**, e não apenas no código.

As decisões de projeto, os trade-offs e as limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stack

Bun 1.x, TypeScript em modo estrito, NestJS, PostgreSQL 16, MikroORM, AWS SQS (LocalStack) e Docker Compose.

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker e Docker Compose

## Setup

```bash
cp .env.example .env
docker compose up -d        # PostgreSQL + LocalStack (as filas SQS são criadas automaticamente)
docker compose ps           # aguarde os dois serviços ficarem "healthy"
bun install
bun run migration:up        # a aplicação NÃO roda migrations sozinha
bun run start               # http://localhost:3000
```

Se a porta 5432 já estiver ocupada na sua máquina (um PostgreSQL instalado localmente, por exemplo), mude `DB_PORT` no `.env` (ex.: `5433`) e rode `docker compose up -d postgres` de novo. O `docker-compose.yml` lê essa variável, e dentro do container o banco continua na 5432.

O `docker compose up` cria também o banco `wagering_test`, usado pelos testes de integração, para que eles nunca toquem nos dados de desenvolvimento.

## Variáveis de ambiente

Todas estão em `.env.example`.

| Variável | Padrão | Uso |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | `localhost`, `5432`, `wagering`, `wagering` | Conexão com o PostgreSQL |
| `DB_NAME` | `wagering` | Banco da aplicação |
| `DB_NAME_TEST` | `wagering_test` | Banco dos testes |
| `AWS_REGION`, `AWS_ENDPOINT_URL` | `us-east-1`, `http://localhost:4566` | SQS (LocalStack) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` | Credenciais fictícias do LocalStack |
| `SQS_WAGER_QUEUE_URL` | `.../wager-transactions.fifo` | Fila de entrada |
| `SQS_WAGER_DLQ_URL` | `.../wager-transactions-dlq.fifo` | Dead-letter queue |
| `SQS_EVENTS_QUEUE_URL` | `.../wager-events.fifo` | Fila de saída da outbox (eventos de integração) |
| `PORT` | `3000` | Porta HTTP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error` |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | Liga o publisher da outbox neste processo |
| `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS` | `20`, `500` | Tamanho do lote e intervalo de espera |
| `SQS_CONSUMER_ENABLED` | `true` | Liga o consumidor SQS neste processo |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | Recebimentos antes de a mensagem ir para a DLQ (erros transitórios) |
| `SQS_CONSUMER_WAIT_TIME_SECONDS` | `20` | Long polling |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | Liga o worker de `PENDING_REFERENCE` neste processo |
| `PENDING_REFERENCE_BATCH_SIZE`, `PENDING_REFERENCE_POLL_INTERVAL_MS` | `20`, `1000` | Lote e intervalo do worker |

Cada processo pode ligar ou desligar o publisher, o consumidor e o worker de forma independente. Isso permite rodar, por exemplo, uma instância só com HTTP e outras só com consumidores.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação (HTTP, publisher da outbox, consumidor SQS e worker de `PENDING_REFERENCE`) |
| `bun run dev` | Igual ao `start`, com reinício automático ao salvar |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Desfaz a última migration |
| `bun run migration:reset` | Desfaz todas e aplica de novo |
| `bun run typecheck` | Verificação de tipos (`tsc --noEmit`) |
| `bun test` | Todos os testes |
| `bun run test:unit` | Testes unitários (não precisam de Docker) |
| `bun run test:integration` | Integração, com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Concorrência com processos reais (várias instâncias, kill -9, reinício) |

Para rodar mais de uma instância na mesma máquina, abra outro terminal com outra porta:

```bash
PORT=3001 bun run start                  # bash
$env:PORT=3001; bun run start            # PowerShell
```

## API

Os valores monetários trafegam sempre como string decimal com duas casas: `{ "amount": "25.00", "currency": "BRL" }`.

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria a wallet. Saldo inicial maior que zero gera a transação interna `OPENING` e o lançamento de crédito. Responde `409` se já existe wallet para o par jogador e moeda |
| `GET /wallets/:walletId` | Consulta a wallet |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50` | Extrato paginado por cursor opaco, do mais novo para o mais antigo (`limit` de 1 a 200) |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo gravado com o saldo recalculado pelo ledger |
| `POST /wagering/transactions` | Submete uma transação. Exige o header `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` | O processo está vivo |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis (`503` se algum não responder) |
| `GET /metrics` | Métricas no formato de texto do Prometheus |

Os endpoints de saúde e de métricas são abertos. A autenticação não foi implementada (ver ARCHITECTURE.md, seção 14).

Status HTTP, em todos os endpoints:

| Status | Situação |
|---|---|
| `200` | Transação aplicada, ou replay idempotente (`idempotentReplay: true`) |
| `201` | Wallet criada |
| `202` | Aceita, mas ainda aguardando a transação referenciada (`PENDING_REFERENCE`) |
| `400` | Payload, parâmetro ou `Idempotency-Key` inválido |
| `404` | Wallet ou transação não encontrada |
| `409` | Conflito: mesma `Idempotency-Key` com payload diferente, ou wallet duplicada |
| `422` | Rejeitada por regra de negócio (o corpo traz o `failureCode`) |
| `503` | Falha transitória de infraestrutura, com `Retry-After`: reenvie com a mesma `Idempotency-Key` |

Erros seguem sempre o formato `{ "error": { "code": "...", "message": "...", "retryable": false } }`. A tabela completa de códigos está no ARCHITECTURE.md.

### Exemplo

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "tx-1",
    "playerId": "player-1",
    "walletId": "<id devolvido acima>",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Reenviar a segunda requisição devolve o mesmo `transactionId` e o mesmo saldo, com `idempotentReplay: true`. No PowerShell, use `curl.exe` (o `curl` é um alias de outro comando) ou `Invoke-RestMethod`.

## Filas SQS

Criadas pelo `docker/localstack/init-sqs.sh` quando o LocalStack fica pronto.

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada: mensagens `WagerTransactionRequested`. O `MessageGroupId` deve ser o `walletId` |
| `wager-transactions-dlq.fifo` | Mensagens que não puderam ser processadas, com o motivo nos atributos |
| `wager-events.fifo` | Saída da outbox: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` |

Formato da mensagem de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Testes

Os testes de integração e de concorrência usam PostgreSQL e SQS **reais** (containers do `docker compose`), sem mocks. Antes de rodá-los, confirme que `docker compose ps` mostra os dois serviços `healthy`.

| Pasta | O que cobre |
|---|---|
| `test/unit` | `Money`, `Wallet`, ledger, máquina de estados, hash do payload, política de backoff, mapeamento de erros, métricas |
| `test/integration` | Migrations e constraints, atomicidade, idempotência, inbox e redelivery, outbox, consumidor SQS (retry, DLQ, shutdown), `PENDING_REFERENCE`, API HTTP, observabilidade |
| `test/concurrency` | Processos reais da aplicação: 3 instâncias disputando as mesmas wallets, 3 consumidores SQS, 2 publishers, `kill -9` no meio da carga, reinício do serviço |

Todos os testes de saldo terminam com a mesma verificação: `wallet.balance == saldo reconstruído pelo ledger`.

O teste de `SIGTERM` em processo real é ignorado no Windows, porque o sistema não entrega esse sinal a um processo filho. Ele roda em Linux, macOS, WSL e CI.

## Estrutura

```
src/
  domain/            Regras puras: Money, Wallet, ledger, WagerTransaction, inbox, outbox, eventos
  application/       Casos de uso e portas (interfaces de repositório, publisher, observabilidade)
  infrastructure/    PostgreSQL (migrations e repositórios SQL), SQS, log, métricas, autenticação
  interfaces/        Entradas: HTTP, consumidor SQS, workers
test/                unit, integration, concurrency
docker/              Scripts de inicialização do PostgreSQL e do LocalStack
```

As dependências apontam sempre para dentro: o domínio não importa NestJS nem o ORM.

## Fora de escopo

- Autenticação (decisão e desenho em ARCHITECTURE.md, seção 14).
- Teste de carga (`bun run test:load`).
- Contêiner da própria aplicação: o Docker Compose sobe a infraestrutura, e a aplicação roda com `bun run start`.