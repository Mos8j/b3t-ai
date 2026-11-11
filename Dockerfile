FROM node:24-bookworm
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package.json package-lock.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY db/migrations/ ./db/migrations/
COPY tsconfig.base.json ./
RUN npm ci --include=dev && npx playwright install --with-deps chromium
USER node
EXPOSE 10000
CMD ["sh", "-c", "node packages/db/src/migrate.mjs && node --import tsx apps/api/src/index.ts"]
