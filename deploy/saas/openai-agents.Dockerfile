FROM node:26.3.0-bookworm-slim
WORKDIR /app
COPY apps/openai-agents-worker/package.json apps/openai-agents-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY apps/openai-agents-worker/ ./
COPY apps/user-models.ts /user-models.ts
COPY apps/computer-model.ts /computer-model.ts
USER node
EXPOSE 8098
CMD ["node", "server.mjs"]
