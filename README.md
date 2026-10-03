# Newtonite

Newtonite is a workflow tracking tool demonstrating a Postgres-backed, transactional outbox pattern with optimistic concurrency, built in a monorepo setup (API, Worker, Web).

## Prerequisites
- Node.js 20+
- PostgreSQL 16+

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Setup Database**
   Configure your database URL (default is `postgres://postgres:password@localhost:5432/newtonite`).
   Run migrations and seed the database:
   ```bash
   npm run migrate
   npm run seed
   ```

   **Seed Data:** The seed script creates 5 teams, 20 users, and a configurable number of work items (default 10,000, controllable via `SEED_SIZE`). Look at the console output of the seed script or check the database to get a user email (e.g. `user0@example.com`, password: `password123`).

3. **Run Services**
   Open three separate terminals and run:
   ```bash
   # Terminal 1: API
   npm run dev:api

   # Terminal 2: Worker
   npm run dev:worker

   # Terminal 3: Frontend (Web)
   npm run dev:web
   ```

4. **Testing**
   Integration tests run against a real Postgres instance to verify concurrency, idempotency, and the outbox pattern.
   ```bash
   cd api && npx vitest
   ```

## Architecture Diagram

```mermaid
graph TD
    UI[Frontend (Vite/React)] -->|REST| API[Fastify API]
    API -->|Tx: Write Item + Event + Job| DB[(PostgreSQL)]
    Worker[Background Worker] -->|FOR UPDATE SKIP LOCKED| DB
    Worker -->|Create Notifications| DB
```

## Features
- Optimistic Concurrency Control (via `version`)
- Transactional Outbox Pattern for jobs
- Centralized Policy engine for Authorization
- Idempotent API mutations (using `Idempotency-Key`)
- Basic Frontend with Dashboard and Work Item management.
