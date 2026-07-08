FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persistent data lives here — mount a volume at /data on your host.
ENV DB_PATH=/data/chemocure.db
VOLUME /data

EXPOSE 3000
CMD ["node", "src/server.js"]
