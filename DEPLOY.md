# Deploy chessRecall: All-Local Oracle

Everything on Oracle. Nothing external, nothing paid.

- Postgres (Docker, private)
- Redis (Docker, private)
- Worker (Docker, private)
- Next.js App (Docker, exposed via HTTP)

All in one `docker-compose.yml`.

---

## 2 Steps

### Step 1: Configure .env and Deploy

SSH into Oracle and run:

```bash
cd /home/ubuntu/chessRecall

cp .env.example .env
nano .env

# Required values in .env:
# NEXT_PUBLIC_SUPABASE_URL=
# NEXT_PUBLIC_SUPABASE_ANON_KEY=
# SUPABASE_SERVICE_ROLE_KEY=
# POSTGRES_PASSWORD=
# REDIS_PASSWORD=

# Build and start everything
docker compose up -d --build

# Check status
docker compose ps
```

**Expected:**
```
CONTAINER ID   IMAGE                    STATUS
xxx            postgres:16-alpine       Up (healthy)
xxx            redis:7-alpine           Up (healthy)
xxx            chessrecall-worker       Up
xxx            chessrecall-app          Up
```

Open browser: `https://chessrecall.qzz.io`

Should see login page. ✅

---

### Step 2: Test & Use

1. **Browser:** Go to `https://chessrecall.qzz.io`
2. **See login page** - it works! ✅
3. **Log in** with Supabase account
4. **Import a game** from Lichess/Chess.com
5. **Click "Analyze"**
6. **Watch logs** (in real-time):
   ```bash
   docker compose logs -f worker
   ```
   
   Should see:
   ```
   worker_1 | [worker] Job game-XXX started
   worker_1 | [worker] Analyzing with Stockfish...
   worker_1 | [worker] Found 3 blunders
   worker_1 | [worker] Puzzles inserted
   ```

7. **Refresh browser** - puzzles appear

✅ Done. Everything works locally.

---

## Security

Use strong passwords (20+ chars, mix upper/lower/numbers).

Supabase keys are only in `.env` (gitignored). Before going live:
1. Supabase → Settings → API → Regenerate both keys
2. Update `.env`
3. `docker compose restart app`

---

## Commands

Check status:
```bash
docker compose ps
```

View logs:
```bash
docker compose logs -f [app|worker|postgres|redis]
```

Restart app:
```bash
docker compose restart app
```

Stop everything:
```bash
docker compose down
```

Rebuild everything:
```bash
docker compose up -d --build
```

---

## Add a Domain (Later)

When you want `https://chessrecall.com` instead of `https://chessrecall.qzz.io`:

1. Buy domain (~€5/year at GoDaddy/Namecheap)
2. Point DNS to your server public IP
3. Add Nginx reverse proxy with SSL (Let's Encrypt free)
   
This is a separate setup - ask me when you need it.

---

## Issues

| Problem | Fix |
|---------|-----|
| Browser can't reach `https://chessrecall.qzz.io` | Check `docker compose ps` - all 4 containers up? |
| Worker not processing jobs | Check `docker compose logs worker` for errors |
| Login page spins forever | Check Supabase keys are correct |
| App can't connect to Postgres | Check password matches in docker-compose.yml |

---

## Architecture

```
Oracle (your-server)
┌──────────────────────────────────────┐
│ Docker Compose (private network)     │
├──────────────────────────────────────┤
│ ├─ Postgres (internal, no port)      │
│ ├─ Redis (internal, no port)         │
│ ├─ Worker (analysis engine)          │
│ └─ Next.js App (port 3000)           │
└──────────────────────────────────────┘
         ↓
   https://chessrecall.qzz.io
    (only thing exposed to internet)
```

Everything runs locally. Zero external services. Zero costs.

---

Done. You're live.
