FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY db/package.json ./db/
COPY panel/package.json ./panel/
RUN npm ci
COPY core ./core
COPY db ./db
COPY panel ./panel
RUN npm run build -w @linkyard/panel

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY core/package.json ./core/
COPY db/package.json ./db/
COPY panel/package.json ./panel/
RUN npm ci --omit=dev
COPY core ./core
COPY db ./db
COPY --from=build /app/panel/build ./panel/build
COPY panel/public ./panel/public
COPY panel/seed ./panel/seed
COPY panel/start.mjs ./panel/start.mjs
COPY panel/app/lib ./panel/app/lib
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@linkyard/panel"]
