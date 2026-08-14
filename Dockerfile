FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY admin ./admin
COPY scripts ./scripts
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 13280 13281
CMD ["node", "server/index.mjs"]
