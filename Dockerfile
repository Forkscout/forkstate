# Bun rather than Node for one measured reason: the binary is 70 MB against
# Node's 121 MB, and nothing here needs a package manager at runtime. Both
# runtimes are supported by the source — see src/sqlite.ts for the one place
# they differ — so this is a packaging choice, not a lock-in.
#
# There is no build step on purpose: Bun runs the TypeScript directly, so the
# image carries a runtime and the source, with no compiler or bundler in it.
FROM oven/bun:alpine AS deps
WORKDIR /app

# The cache and the source maps have to go in the same layer that creates them:
# deleting them afterwards only adds a layer, it does not shrink the image.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile \
    && find node_modules -name "*.map" -delete \
    && find node_modules \( -name "*.md" -o -name "LICENSE*" -o -name ".github" \) -prune -exec rm -rf {} + \
    && rm -rf /root/.bun/install/cache

FROM alpine:3.21
RUN apk add --no-cache libstdc++ \
    && addgroup -S app && adduser -S -G app app
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Where the overlay database goes when there is no DATABASE_URL. Declaring a
# VOLUME here is not what makes a mount work — `docker run -v` and every
# platform's own volumes work without it — and Railway rejects the instruction
# outright, so it is left out.
RUN mkdir -p /app/data && chown -R app:app /app/data
USER app

# The port comes from the platform; EXPOSE is documentation.
EXPOSE 8546

# Carries the key when one is set — without it the check gets the 401 the key is
# there to produce, and a perfectly healthy engine reports itself unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.FORKSTATE_PORT||process.env.PORT||8546)+'/environments',{headers:process.env.FORKSTATE_KEY?{'x-forkstate-key':process.env.FORKSTATE_KEY}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
