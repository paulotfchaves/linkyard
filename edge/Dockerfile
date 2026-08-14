# The edge has no build step. Node 24 strips TypeScript annotations at load, so
# the two panel modules this service shares — the link rules and the schedule
# executor — ship as source and stay byte-identical to the ones the panel runs.
# A compiled copy would be a second implementation waiting to drift.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Every workspace manifest, because npm ci refuses a lockfile it cannot match to
# the full workspace set — even for the ones this image never runs.
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY db/package.json ./db/
COPY panel/package.json ./panel/
COPY edge/package.json ./edge/
RUN npm ci --omit=dev --workspace @linkyard/edge --include-workspace-root

COPY edge ./edge
# Only app/lib: the edge never serves panel HTML, and copying the routes in
# would put a React tree one careless import away from the critical path.
COPY panel/app/lib ./panel/app/lib

# Migrations are the panel's job. Two processes racing the same schema is how a
# deploy turns into a half-applied migration nobody can name.
EXPOSE 8080
CMD ["node", "edge/src/server.mjs"]
