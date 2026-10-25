FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund --loglevel=verbose
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
EXPOSE 3001
CMD ["npm", "run", "dev"]
