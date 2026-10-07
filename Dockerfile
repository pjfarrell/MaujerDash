# node:20-alpine is multi-arch, so this same file builds on a Raspberry Pi
# (arm64 on a 64-bit Pi OS, arm/v7 on 32-bit) as well as on a laptop.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is the slow one on a Pi, and it only rebuilds
# when the manifests change rather than on every edit to the app.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js home.html dashboard.html shared.js shared.css stations.json ./
COPY scripts ./scripts

# The node image ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
