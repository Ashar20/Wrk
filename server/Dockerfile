FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY stubs ./stubs
RUN npm ci --omit=dev --ignore-scripts=false && npm i --no-save tsx
COPY tsconfig.json ./
COPY src ./src
COPY model-results.json ./
COPY models ./models
ENV PORT=8080 WRK_DATA_DIR=/data
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
