# MediFlow — local/demo Docker image.
#
# Builds the web-app (demo-mode bundle) and api-server, then serves the built
# static bundle from the api-server process (same layout the Render demo
# blueprint uses — see render.yaml). Not a slim production image: node_modules
# are kept in full so `drizzle-kit migrate` and the `tsx` demo seed script
# (both devDependencies) can run at container start.
FROM node:24-slim AS app

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

# Copy workspace manifests first (not full source) so `pnpm install` is only
# re-run when a package.json/lockfile actually changes, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/package.json
COPY artifacts/web-app/package.json artifacts/web-app/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/devtools/package.json lib/devtools/package.json
COPY lib/integrations-openai-ai-react/package.json lib/integrations-openai-ai-react/package.json
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/package.json
COPY lib/object-storage-web/package.json lib/object-storage-web/package.json
COPY scripts/package.json scripts/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN VITE_DEMO_MODE=true pnpm --filter @workspace/web-app run build \
  && pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["sh", "./docker/start.sh"]
