# chessRecall (app)

App Next.js para importar/analisar jogos e fazer review (com Stockfish + árvore de variações).

## Requisitos

- Node.js 20+
- Docker Desktop (para Redis, necessário para o queue/worker de análise)

## Instalação

```bash
cd chess-recall-app
npm install
```

## Dev (apenas UI)

```bash
npm run dev
```

Abrir http://localhost:3000

## Dev (com análise em background: Redis + worker + UI)

Em 3 terminais separados:

```bash
npm run redis:up
```

```bash
npm run worker
```

```bash
npm run dev
```

## Scripts úteis

- `npm run dev`: Next dev server
- `npm run build`: build de produção
- `npm run start`: serve build de produção
- `npm run lint`: ESLint
- `npm run worker`: processa a fila de análises (BullMQ) e escreve resultados
- `npm run redis:up`: sobe Redis via Docker
- `npm run redis:down`: desce Redis
- `npm run redis:logs`: logs do Redis

## Troubleshooting

- Mensagem “Redis queue offline. Start Redis + worker and try again.”
  - Corre `npm run redis:up` e depois `npm run worker`.
- Worker não inicia no Windows
  - Garante Node 20+ e reinstala deps: `rm -r node_modules && npm i` (ou apaga a pasta manualmente no Explorer).
- Import/Analyze não encontra jogos
  - Confirma que tens as contas vinculadas dentro da app (Lichess/Chess.com) e que o username está correto.
