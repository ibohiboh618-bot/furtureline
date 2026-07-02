FROM node:20-slim
WORKDIR /usr/src/app

# Install build tools for native modules and Python for optional scripts.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 python3-dev ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Use npm install to be tolerant when package-lock.json is absent in local dev
RUN npm install --production

COPY . ./

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-c", "[ \"$RUN_MODE\" = \"worker\" ] && npm run start:verify-worker || npm run start:verify-service"]
