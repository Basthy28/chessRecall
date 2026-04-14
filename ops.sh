#!/bin/bash

# Chess Recall Operations Script
# Usage: ./ops.sh [command]

set -e

COMPOSE_PROD="docker-compose.yml"
COMPOSE_TEST="docker-compose.test.yml"
TEST_PROJECT="chessrecall-test"
PG_CONTAINER="chessrecall-postgres"
ROOT_FOLDER="/home/ubuntu/chessRecall"

cd "$ROOT_FOLDER"

# Load .env when available so POSTGRES_* defaults can be overridden safely.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PGUSER="${POSTGRES_USER:-chessrecall}"
PGDB="${POSTGRES_DB:-chessrecall}"

psql_exec() {
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"
}

redis_exec() {
  local redis_password="${REDIS_PASSWORD:-}"
  if [[ -n "$redis_password" ]]; then
    docker exec -i chessrecall-redis redis-cli -a "$redis_password" "$@"
  else
    docker exec -i chessrecall-redis redis-cli "$@"
  fi
}

clear_analyze_queue_keys() {
  # BullMQ stores queue data under bull:<queue-name>*
  mapfile -t keys < <(redis_exec --scan --pattern "bull:analyze-game*" 2>/dev/null || true)

  if [[ ${#keys[@]} -eq 0 ]]; then
    echo "No analyze queue keys found in Redis."
    return 0
  fi

  redis_exec DEL "${keys[@]}" >/dev/null
  echo "Cleared ${#keys[@]} analyze queue key(s) from Redis."
}

require_user_id() {
  if [[ -z "${2:-}" ]]; then
    echo "Missing user_id"
    echo "Usage: ./ops.sh $1 <user_id>"
    exit 1
  fi
}

case "${1:-help}" in
  test-up)
    echo "Starting test environment (port 3002, same DB as production)..."
    docker compose -f "$COMPOSE_PROD" up -d postgres redis >/dev/null
    docker compose -p "$TEST_PROJECT" -f "$COMPOSE_TEST" up -d --build app-test
    echo "Test app running at 127.0.0.1:3002"
    echo "Tunnel from local: ssh -L 3002:127.0.0.1:3002 oracle"
    ;;

  test-rebuild)
    echo "Rebuilding test app only (production untouched)..."
    docker compose -p "$TEST_PROJECT" -f "$COMPOSE_TEST" up -d --build app-test
    echo "Test app rebuilt on 127.0.0.1:3002"
    ;;

  test-down)
    echo "Stopping test environment only..."
    docker compose -p "$TEST_PROJECT" -f "$COMPOSE_TEST" down
    echo "Test environment stopped (production still running)"
    ;;

  test-clean)
    echo "Cleaning test environment..."
    docker compose -p "$TEST_PROJECT" -f "$COMPOSE_TEST" down
    echo "Test environment cleaned (production still running)"
    ;;

  test-logs)
    echo "Test app logs (last 50 lines)..."
    docker compose -p "$TEST_PROJECT" -f "$COMPOSE_TEST" logs app-test -f --tail=50
    ;;

  prod-deploy)
    echo "Deploying to production..."
    echo "Pulling latest code (fast-forward only)..."
    git pull --ff-only origin main
    echo "Building fresh app/worker images..."
    docker compose -f "$COMPOSE_PROD" build --pull app worker
    echo "Recreating production services with new images..."
    docker compose -f "$COMPOSE_PROD" up -d --force-recreate --no-deps app worker cloudflared
    echo "Production deployed!"
    echo "Check at https://chessrecall.qzz.io"
    ;;

  prod-up)
    echo "Ensuring production services are up (safe recovery)..."
    docker compose -f "$COMPOSE_PROD" up -d postgres redis app worker cloudflared
    echo "Production services are running"
    ;;

  prod-rebuild)
    echo "Rebuilding production app/worker and recreating containers..."
    docker compose -f "$COMPOSE_PROD" build --pull app worker
    docker compose -f "$COMPOSE_PROD" up -d --force-recreate --no-deps app worker cloudflared
    echo "Production rebuild done"
    ;;

  prod-rebuild-hard)
    echo "Hard rebuild production app/worker (no cache) and recreate containers..."
    docker compose -f "$COMPOSE_PROD" build --no-cache --pull app worker
    docker compose -f "$COMPOSE_PROD" up -d --force-recreate --no-deps app worker cloudflared
    echo "Production hard rebuild done"
    ;;

  prod-logs)
    echo "Production app logs (last 50 lines)..."
    docker compose -f "$COMPOSE_PROD" logs -f app --tail=50
    ;;

  status)
    echo "Service Status:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "chessrecall|^NAMES"
    ;;

  db-users)
    echo "Users in local DB (games table):"
    psql_exec -c "
      SELECT user_id,
             count(*) AS games,
             min(played_at) AS first_game,
             max(played_at) AS last_game
      FROM games
      GROUP BY user_id
      ORDER BY max(played_at) DESC;
    "
    ;;

  db-user-stats)
    require_user_id "$1" "$2"
    echo "Stats for user_id=$2"
    psql_exec -c "
      SELECT '$2'::uuid AS user_id,
        (SELECT count(*) FROM games WHERE user_id = '$2'::uuid) AS games,
        (SELECT count(*) FROM puzzles WHERE user_id = '$2'::uuid) AS puzzles,
        (SELECT count(*) FROM import_sync_cooldowns WHERE user_id = '$2'::uuid) AS cooldowns;
    "
    ;;

  db-purge-user)
    require_user_id "$1" "$2"
    echo "Purging local data for user_id=$2 (games, puzzles via cascade, cooldowns)..."
    psql_exec -c "
      BEGIN;
      DELETE FROM import_sync_cooldowns WHERE user_id = '$2'::uuid;
      DELETE FROM games WHERE user_id = '$2'::uuid;
      COMMIT;
    "
    echo "Purge complete for user_id=$2"
    ;;

  db-purge-user-safe)
    require_user_id "$1" "$2"
    echo "Safe purge for user_id=$2: stop worker -> purge DB -> clear analyze queue -> start worker"
    docker compose -f "$COMPOSE_PROD" stop worker >/dev/null || true
    psql_exec -c "
      BEGIN;
      DELETE FROM import_sync_cooldowns WHERE user_id = '$2'::uuid;
      DELETE FROM games WHERE user_id = '$2'::uuid;
      COMMIT;
    "
    clear_analyze_queue_keys
    docker compose -f "$COMPOSE_PROD" up -d worker >/dev/null
    echo "Safe purge complete for user_id=$2"
    ;;

  db-requeue-analyzed)
    require_user_id "$1" "$2"
    echo "Resetting analyzed games for user_id=$2 back to 'failed' (puzzles wiped for clean re-run)..."
    psql_exec -c "
      BEGIN;
      DELETE FROM puzzles
        WHERE game_id IN (
          SELECT id FROM games WHERE user_id = '$2'::uuid AND status = 'analyzed'
        );
      UPDATE games SET status = 'failed'
        WHERE user_id = '$2'::uuid AND status = 'analyzed';
      COMMIT;
    "
    psql_exec -c "SELECT count(*) AS games_reset FROM games WHERE user_id = '$2'::uuid AND status = 'failed';"
    echo "Done. Use the app UI (Queue Backlog) or /api/analyze to re-queue."
    ;;

  help|*)
    cat << 'EOF'
Chess Recall Operations

TESTING (Same DB, separate app port):
  ./ops.sh test-up      Start test app (port 3002)
  ./ops.sh test-rebuild Rebuild only test app after code changes
  ./ops.sh test-down    Stop test app
  ./ops.sh test-clean   Stop/remove test app container only
  ./ops.sh test-logs    Follow test app logs

PRODUCTION:
  ./ops.sh prod-deploy  Pull + rebuild app/worker/cloudflared
  ./ops.sh prod-up      Recover/start production safely (no test impact)
  ./ops.sh prod-rebuild Rebuild app/worker/cloudflared only
  ./ops.sh prod-rebuild-hard Force no-cache rebuild app/worker + recreate containers
  ./ops.sh prod-logs    Follow production app logs

MONITORING:
  ./ops.sh status       Show all service status

DB OPERATIONS (Local Postgres only):
  ./ops.sh db-users                      List users present in games
  ./ops.sh db-user-stats <user_id>       Show games/puzzles/cooldowns for a user
  ./ops.sh db-purge-user <user_id>       Delete local data for a user
  ./ops.sh db-purge-user-safe <user_id>  Purge user + clear analyze queue safely (stop/start worker)
  ./ops.sh db-requeue-analyzed <user_id> Reset all analyzed games to failed + wipe their puzzles (re-run analysis)

WORKFLOW EXAMPLE:
  1. Start test:     ./ops.sh test-up
  2. Edit code and rebuild test: ./ops.sh test-rebuild
  3. Test via tunnel: http://127.0.0.1:3002
  4. Stop test:      ./ops.sh test-down
  5. Deploy:         ./ops.sh prod-deploy

CRASH RECOVERY (production):
  ./ops.sh prod-up

SSH TUNNEL (from your local machine):
  ssh -L 3002:127.0.0.1:3002 oracle
  Then visit: http://127.0.0.1:3002

EOF
    ;;
esac
