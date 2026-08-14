# The hosted setup panel.
#
# No `npm ci`, and no node_modules in the image: this workspace declares zero
# dependencies and the Dockerfile is where that stays true. The page receives a
# Railway token and a Cloudflare token in a form field, so every package it could
# load is a package that could read them before the request leaves the process —
# which is the same reason the browser side loads nothing from another origin.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY setup ./setup
# The Secret class, shared with the rest of the product so there is one
# implementation to audit rather than two.
COPY core/secret.mjs ./core/secret.mjs
# The declared topology. Reading it here is what keeps the hosted installer, the
# CLI and Railway's template composer building the same three services.
COPY railway-template.json ./railway-template.json

USER node
EXPOSE 8080
CMD ["node", "setup/src/server.mjs"]
