FROM node:18-alpine
WORKDIR /usr/src/app

# Install apk deps for building native modules if needed
RUN apk add --no-cache build-base python3

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . ./

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start"]
