FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY server ./server
COPY public ./public
COPY sql ./sql
COPY .env.example ./.env.example

RUN mkdir -p data && addgroup -S nodejs && adduser -S appuser -G nodejs && chown -R appuser:nodejs /app
USER appuser

EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5050}/api/health" || exit 1

CMD ["npm", "start"]
