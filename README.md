# chessRecall

**Chess game analysis + puzzle trainer with Stockfish.**

Import games from Lichess/Chess.com, analyze with Stockfish, extract blunders as SRS puzzles.

---

## 🚀 Quick Start (Production)

```bash
cd /home/ubuntu/chessRecall

# Copy example env
cp .env.example .env

# Edit .env with your passwords + Supabase keys
nano .env

# Start everything
docker compose up -d --build

# Done — access at https://chessrecall.qzz.io
```

---

## 📋 What You Get

```
┌─────────────────────────┐
│ Next.js App (port 3000) │  ← Browser access
└──────────┬──────────────┘
           │
    ┌──────┴───────┐
    ↓              ↓
┌─────────┐   ┌────────┐
│Postgres │   │ Redis  │  ← Internal (private)
└─────────┘   └────────┘
    ↑              ↑
    └──── Worker ──┘  ← Analyzes games
```

---

## 🔐 Environment Setup

1. Copy `.env.example` → `.env` (not committed to git)
2. Set strong passwords (min 20 chars):
   - `POSTGRES_PASSWORD=your_secure_password`
   - `REDIS_PASSWORD=your_secure_password`
3. Add Supabase keys (from Supabase dashboard):
   - `NEXT_PUBLIC_SUPABASE_URL=https://...`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...`
   - `SUPABASE_SERVICE_ROLE_KEY=eyJ...`

---

## 📊 Monitoring

View logs:
```bash
docker compose logs -f app     # Next.js app
docker compose logs -f worker  # Game analysis
docker compose logs -f postgres  # Database
```

Access database from PC:
```bash
psql -U chessrecall -h <your-server-host> -d chessrecall
# Password: your_postgres_password
```

---

## 🛑 Operations

Stop everything:
```bash
docker compose down
```

Restart:
```bash
docker compose restart
```

Rebuild (after code changes):
```bash
docker compose up -d --build
```

---

## ⚙️ Architecture

- **Auth**: Supabase (user login, external)
- **Database**: Postgres (games, puzzles, internal)
- **Queue**: Redis + BullMQ (game analysis jobs)
- **Worker**: Stockfish (detects blunders, creates puzzles)
- **App**: Next.js + React (UI)

All containerized. Zero external services (except Supabase for auth).
