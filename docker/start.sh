#!/bin/sh
# Runs inside the app container: apply migrations, seed the INSUREitALL demo
# data (idempotent — no-op if already seeded), then start api-server.
set -e

pnpm --filter @workspace/db run migrate
pnpm seed:demo
exec pnpm --filter @workspace/api-server run start
