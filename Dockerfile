FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY ui/package.json ui/

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN cd ui && npm install --no-audit --no-fund && npm run build

RUN npm run build

EXPOSE 3001 18789

ENV NODE_ENV=production
ENV PILOTDECK_CONFIG_PATH=/data/pilotdeck.yaml

CMD ["npm", "run", "server:built"]
