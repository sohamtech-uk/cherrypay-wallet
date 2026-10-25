FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
EXPOSE 3001
CMD ["npm", "run", "dev"]
