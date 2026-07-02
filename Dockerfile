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

COPY . .

RUN pnpm install --frozen-lockfile

RUN VITE_DEMO_MODE=true pnpm --filter @workspace/web-app run build \
  && pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["sh", "./docker/start.sh"]
