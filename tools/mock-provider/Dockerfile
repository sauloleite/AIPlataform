# syntax=docker/dockerfile:1.7
# Deterministic model provider used only by CI. Never shipped to production.
FROM node:22.19-alpine
WORKDIR /app
COPY server.mjs .
USER node
EXPOSE 8090
CMD ["node", "server.mjs"]
