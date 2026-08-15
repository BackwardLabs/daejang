FROM node:22.13-bookworm-slim AS preview

ARG VITE_REOWN_PROJECT_ID
ENV NODE_ENV=development
ENV VITE_REOWN_PROJECT_ID=${VITE_REOWN_PROJECT_ID}
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/edge/package.json apps/edge/package.json
COPY apps/web-api/package.json apps/web-api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @daejang/web --include-workspace-root

COPY apps/web apps/web
COPY scripts/check-web-bundle-cycles.mjs scripts/check-web-bundle-cycles.mjs
COPY scripts/check-web-report-surface.mjs scripts/check-web-report-surface.mjs
RUN npm run build --workspace @daejang/web

EXPOSE 5173
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5173').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "run", "preview", "--workspace", "@daejang/web", "--", "--host", "0.0.0.0", "--port", "5173"]
