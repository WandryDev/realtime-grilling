# The analytics server with the web it serves (call-analytics design.md,
# decision 10). Built from the repository's root:
#   docker build -f analytics/Dockerfile .
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY analytics ./analytics
RUN bun install --frozen-lockfile --ignore-scripts
# The web's static export, when the package is there.
RUN if [ -d analytics/web ]; then bun run --filter @grill/analytics-web build; fi

FROM oven/bun:1.4.2
WORKDIR /app
COPY --from=build /app /app
ENV PORT=8787 \
    HOST=0.0.0.0 \
    WEB_DIR=/app/analytics/web/out
EXPOSE 8787
CMD ["bun", "analytics/server/src/main.ts"]
