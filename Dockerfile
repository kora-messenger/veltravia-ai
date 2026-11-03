# Veltravia API in a container.
#
# Two stages, because the toolchain that builds the TypeScript workspaces is
# large and the running image should not carry it. The runtime stage holds the
# compiled output and production dependencies only.
#
# The build is from the repo root: the API imports other workspace packages from
# their built output, so a single-package build would produce an image that runs
# and then fails to find its own libraries.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first: a dependency-only layer survives source edits, so a rebuild
# after a code change does not reinstall everything.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY ai/gateway/package.json ai/gateway/
COPY apps/api/package.json apps/api/

RUN npm ci --workspace @veltravia/api --include-workspace-root

COPY packages packages
COPY ai/gateway ai/gateway
COPY apps/api apps/api

RUN npm run build --workspace @veltravia/shared \
  && npm run build --workspace @veltravia/types \
  && npm run build --workspace @veltravia/config \
  && npm run build --workspace @veltravia/ai-gateway \
  && npm run build --workspace @veltravia/api

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Not root: a request handler that escapes its sandbox should not own the image.
RUN useradd --create-home --uid 10001 veltravia
COPY --from=build --chown=veltravia:veltravia /app/node_modules node_modules
COPY --from=build --chown=veltravia:veltravia /app/package.json ./
COPY --from=build --chown=veltravia:veltravia /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=veltravia:veltravia /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=veltravia:veltravia /app/packages/types/package.json packages/types/
COPY --from=build --chown=veltravia:veltravia /app/packages/types/dist packages/types/dist
COPY --from=build --chown=veltravia:veltravia /app/packages/config/package.json packages/config/
COPY --from=build --chown=veltravia:veltravia /app/packages/config/dist packages/config/dist
COPY --from=build --chown=veltravia:veltravia /app/ai/gateway/package.json ai/gateway/
COPY --from=build --chown=veltravia:veltravia /app/ai/gateway/dist ai/gateway/dist
COPY --from=build --chown=veltravia:veltravia /app/apps/api/package.json apps/api/
COPY --from=build --chown=veltravia:veltravia /app/apps/api/dist apps/api/dist

# Durable file storage, when VELTRAVIA_STORAGE_DRIVER=file, writes here.
RUN mkdir -p /app/data && chown veltravia:veltravia /app/data
ENV VELTRAVIA_DATA_DIR=/app/data

USER veltravia
EXPOSE 3000

# Liveness only: it must not depend on the model provider, or a busy provider
# would get a healthy process restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
