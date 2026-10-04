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

2. **Docker Compose (Recommended)**
   To run the entire stack (PostgreSQL, API, Worker, Web) in Docker:
   ```bash
   docker compose up -d
   ```
   *Note: If you use Docker, run migrations and seeding inside the API container:*
   ```bash
   docker compose exec api npm run migrate -w api
   docker compose exec api npm run seed -w api
   ```
   The app will be available at `http://localhost:5173`.

3. **Manual Setup (Without Docker)**
   
   **Setup Database**
   Configure your database URL (default is `postgres://postgres:password@localhost:5432/newtonite`).
   Run migrations and seed the database:
   ```bash
   npm run migrate
   npm run seed
   ```

   **Seed Data:** The seed script creates 5 teams, 20 users, and a configurable number of work items (default 10,000, controllable via `SEED_SIZE`). Look at the console output of the seed script or check the database to get a user email (e.g. `user0@example.com`, password: `password123`).

4. **Run Services**
   Open three separate terminals and run:
   ```bash
   # Terminal 1: API
   npm run dev:api

   # Terminal 2: Worker
   npm run dev:worker

   # Terminal 3: Frontend (Web)
   npm run dev:web
   ```

5. **Testing**
   Integration tests run against a real Postgres instance to verify concurrency, idempotency, and the outbox pattern.
   ```bash
   cd api && npx vitest
   ```

## Architecture Diagram

```mermaid
graph TD
    UI[Frontend_App] -->|HTTP_REST| API[Fastify_API]
    API -->|Tx_Write_Item_Event_Job| DB[(PostgreSQL)]
    Worker[Background_Worker] -->|FOR_UPDATE_SKIP_LOCKED| DB
    Worker -->|Create_Notifications| DB
```

## Features
- Optimistic Concurrency Control (via `version`)
- Transactional Outbox Pattern for jobs
- Centralized Policy engine for Authorization
- Idempotent API mutations (using `Idempotency-Key`)
- Basic Frontend with Dashboard and Work Item management.

## Assumptions
- We assume that PostgreSQL 16+ is used as the single source of truth for both data and queueing (via `FOR UPDATE SKIP LOCKED`) because we intentionally avoided Kafka or Redis to minimize infrastructural complexity.
- We assume teams operate semi-independently and users might belong to multiple teams with different roles, but work items strictly belong to a single team.
- The UI assumes optimistic state management is acceptable (it does not require a real-time websocket connection yet) and gracefully recovers from `409 Conflict` errors by refreshing the data.
- The API assumes users must provide their own UUID `Idempotency-Key` headers for mutations.
- The worker assumes a crash can happen at any time, using a 5-minute visibility timeout to reclaim leased jobs.
