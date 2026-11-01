# Podium server + UI. Build: podiumctl build   (or: podman build -t localhost/podium:latest -f Containerfile ., or docker build the same)
FROM docker.io/library/node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY frontend/package.json frontend/
# --ignore-scripts: no dependency needs an install script (the database is node:sqlite, esbuild ships a prebuilt
# binary), so none is trusted to run. If one ever does, rebuild just that package with `npm rebuild <pkg>`.
RUN npm ci --ignore-scripts
# The UI imports the view types from server/src/fleet, so both trees are needed before either build.
COPY server server
COPY frontend frontend
# The UI's standards generator (frontend/src/fleet/standards) imports scripts/standards-inventory, and the frontend build
# type-checks it. scripts is only read here; nothing from it reaches the final image.
COPY scripts scripts
RUN npm run build -w frontend && npm run build -w server

FROM docker.io/library/node:26-slim
# The server makes the CA and its certificates by calling openssl (built-in TLS, #577); the slim image does not carry it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 PODIUM_DB=/data/podium.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY frontend/package.json frontend/
RUN npm ci --ignore-scripts --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/frontend/dist frontend/dist
RUN mkdir /data && chown node:node /data
VOLUME /data
# The commit of a dev build (podiumctl build passes it); empty for a release. Last, so a new commit rebuilds only this layer.
ARG PODIUM_BUILD=
ENV PODIUM_BUILD=$PODIUM_BUILD
USER node
EXPOSE 4317 4318
CMD ["node", "server/dist/index.js"]
