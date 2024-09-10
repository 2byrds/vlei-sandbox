FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY vitest.config.ts ./
COPY src ./src

CMD ["npm", "start"]