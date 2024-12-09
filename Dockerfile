# Use a base image with the correct platform
FROM --platform=linux/amd64 node:20-alpine AS base

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY vitest.config.ts ./
COPY src ./src

# Use a separate stage for the final image
FROM --platform=linux/amd64 node:20-alpine

WORKDIR /app
COPY --from=base /app /app

CMD ["npm", "run", "start", "src/issues/multisig-issuance-problem.test.ts"]