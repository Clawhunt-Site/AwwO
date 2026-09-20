FROM node:26.3.0-bookworm-slim
WORKDIR /app
COPY apps/pi-worker/package.json apps/pi-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY apps/pi-worker/ ./
COPY apps/user-models.ts /user-models.ts
USER node
EXPOSE 8097
CMD ["node", "server.mjs"]
