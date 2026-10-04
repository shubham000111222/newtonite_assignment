# Known Limitations

- **No SSO or Complex Auth**: We currently use simple email/password authentication (Argon2). Real environments typically require SAML/OIDC.
- **No Attachments**: The system tracks text metadata but does not support file uploads or cloud storage links yet.
- **No SLA Engine**: There are no background timers pushing SLA warnings automatically based on complex business hours.
- **Polling over Push**: The frontend relies on HTTP request/response polling or optimistic UI, instead of a real-time WebSocket connection to receive live updates.
- **Single Region/Database**: We assume a single primary database. In a highly distributed setup, this could be a bottleneck.
- **In-App Notifications Only**: We only create internal notification records. Email or Slack integrations are omitted for scope.
- **Untuned Search Ranking**: We use basic PostgreSQL `websearch_to_tsquery` without advanced ranking or weighting logic.
- **Flat Team Hierarchy**: Users can belong to multiple teams, but there is no concept of nested organizational units, meaning "All My Teams" aggregates via strict SQL `ANY($1)` arrays rather than hierarchical indexing.

### What I'd do with another week
- Implement a robust WebSocket service (perhaps separated, using Redis PubSub or Postgres LISTEN/NOTIFY internally) to stream live events to users looking at the same item.
- Add granular file upload support integrated with S3, along with signed URLs.
- Build a more expansive filtering UI in the frontend with saved views for users.

### What changes at 10x scale
- **Read Replicas**: The frontend dashboard queries (`COUNT(*)`) would hit read replicas. We might also use materialized views for the dashboard summaries refreshed asynchronously.
- **Events Partitioning**: The `events` and `jobs` tables would be partitioned by time (e.g., monthly) to prevent the table size from crippling performance, and old data would be archived.
- **A Real Queue**: While `SKIP LOCKED` scales well, at extreme throughput (e.g., 10,000s of jobs/sec), we would likely transition the outbox pattern to CDC (Change Data Capture) via Debezium and write to Kafka.
- **Push Updates**: Transition completely from polling to push for notifications and live list updates to reduce database read load.
