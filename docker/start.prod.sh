#!/bin/sh
# Runs inside the Cloud Run container: apply migrations, then start
# api-server. No demo seeding — production starts empty and is populated
# through the app. Safe under Cloud Run's concurrent cold starts: migrate.ts
# serializes on a Postgres advisory lock (see lib/db/src/migrate-locked.ts),
# so overlapping instance boots race harmlessly instead of corrupting the
# migration journal.
set -e

pnpm --filter @workspace/db run migrate
exec pnpm --filter @workspace/api-server run start
