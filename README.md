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

# Done — access at http://chessrecall.qzz.io:3000
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
psql -U chessrecall -h chessrecall.qzz.io -d chessrecall
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

---

## 🔴 Security Issues & Fixes

### Issue 1: Supabase Keys in .env (Not Committed, But Still Private)
- **Risk**: If `.env` is accidentally copied/shared, keys are exposed
- **Fix**: ✅ Keys are secret role (only server-side)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public (browser sees it anyway)
  - `SUPABASE_SERVICE_ROLE_KEY` is private (server only)
- **Action**: Rotate keys before sharing code with anyone

### Issue 2: .env.local Had Exposed Keys (Git History)
- **Risk**: Old commits had `SUPABASE_SERVICE_ROLE_KEY` visible
- **Fix**: ✅ Already removed from git (`git rm --cached .env.local`)
- **Action**: If old commits in public repo, regenerate keys once at production launch

### Issue 3: docker-compose.yml Has Passwords in Text
- **Risk**: If .yml is pushed, passwords visible
- **Fix**: ✅ Added to `.gitignore` (docker-compose*.yml)
- **Action**: Never push `.env` or `docker-compose.yml` with real values

---

## ✅ Current State

- ✅ Code ready (Postgres + Redis + Worker + App in Docker)
- ✅ Running on Oracle at `http://chessrecall.qzz.io:3000`
- ✅ Sensitive files in `.gitignore`
- ✅ `.env.example` as template
- ⚠️ Supabase keys valid but exposed in `DEPLOY.md` doc (should be removed before public)
- ⏳ Recommend: Regenerate Supabase keys once before production users

---

## 🌐 Next: Add Domain (Later)

When ready:
1. Buy domain (~€5/year)
2. Point DNS to `chessrecall.qzz.io`
3. Add Nginx + Let's Encrypt (SSL free)

For now, `http://chessrecall.qzz.io:3000` works.

---

## 📖 Docs

- [DEPLOY.md](DEPLOY.md) - Original deployment guide
- [.env.example](.env.example) - Environment template
