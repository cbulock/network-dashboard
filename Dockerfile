# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NITRO_PRESET=node-server

# Nuxt's postinstall needs the application config, so prepare after copying source.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm rebuild && npm run build

FROM build AS collector-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build --chown=node:node /app/.output ./.output
# Standalone collectors run outside Nitro and need their own dependencies/data.
COPY --from=collector-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/utils ./utils
COPY --from=build --chown=node:node /app/data ./data
RUN mkdir -p /app/.data /home/node/.ssh \
    && chown -R node:node /app/.data /home/node/.ssh \
    && chmod 700 /home/node/.ssh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
