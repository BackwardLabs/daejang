FROM node:22.13-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/edge/package.json apps/edge/package.json
COPY apps/web-api/package.json apps/web-api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @daejang/web-api --include-workspace-root
COPY apps/web-api apps/web-api
COPY proto proto
RUN npm run build --workspace @daejang/web-api && npm prune --omit=dev

FROM node:22.13-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
RUN groupadd --system --gid 65532 daejang \
 && useradd --system --uid 65532 --gid daejang --home-dir /app daejang \
 && install -d -o daejang -g daejang -m 0700 /var/lib/daejang/private
COPY --from=build --chown=daejang:daejang /app/node_modules ./node_modules
COPY --from=build --chown=daejang:daejang /app/apps/web-api/dist ./apps/web-api/dist
COPY --from=build --chown=daejang:daejang /app/apps/web-api/package.json ./apps/web-api/package.json
COPY --from=build --chown=daejang:daejang /app/apps/web-api/assets ./apps/web-api/assets
COPY --from=build --chown=daejang:daejang /app/proto ./proto
USER daejang
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node","apps/web-api/dist/server.js"]
