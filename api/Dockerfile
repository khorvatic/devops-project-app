FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev


FROM node:20-alpine AS dev
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY --chown=node:node src ./src

ENV NODE_ENV=development
EXPOSE 8080

USER node

CMD ["npm", "run", "dev"]


FROM node:20-alpine AS production
WORKDIR /app

RUN apk update && apk upgrade --no-cache

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src

RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/corepack

ENV NODE_ENV=production
EXPOSE 8080

USER node

CMD ["node", "src/server.js"]