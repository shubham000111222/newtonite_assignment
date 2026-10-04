FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY web/package.json ./web/
COPY shared/package.json ./shared/

RUN npm ci

COPY . .

RUN sed -i 's/\r$//' /app/startup.sh && chmod +x /app/startup.sh
