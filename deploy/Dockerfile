ARG NODE_IMAGE=node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
CMD ["node", "dist/server/main.js"]
FROM app AS provider
USER root
RUN npm install --prefix /app/codex --omit=dev --save-exact @openai/codex@0.153.4
ENV CODEX_HOME=/data/codex CODEX_BIN=/app/codex/node_modules/.bin/codex
USER node
CMD ["node", "dist/provider/main.js"]
