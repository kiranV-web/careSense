FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./dist/src/db/migrations
RUN mkdir -p /app/storage/uploads /app/storage/transcription-tmp && chown -R node:node /app/storage
USER node
EXPOSE 3000
CMD ["npm", "start"]
