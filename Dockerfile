# Node 24 because Eve requires it. labs-asp production runs on Cloud Run, so
# this image keeps the GCP path open even though `vercel deploy` is the default
# for the prototype — see README "Deploy target".
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/lib/db/migrations ./lib/db/migrations
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/tsx lib/db/migrate.ts && node server.js"]
