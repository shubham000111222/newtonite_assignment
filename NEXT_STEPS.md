# NEXT_STEPS.md: Newtonite challenge, final stretch

**Deadline: 4 Oct 2026, 10:00 AM IST.** Work top to bottom. If time runs short, do steps 1, 3, 5 and 7 and list anything unfinished in `KNOWN_LIMITATIONS.md`.
**Never cut:** the critical behaviours, their tests, or the docs.

Legend: `[ ]` todo, `[~]` in progress, `[x]` done and verified

---

## 0. Pending Antigravity prompt (send first if not done)

- [ ] Claim button driven by server `allowedActions` only (no Claim on CLOSED or other unclaimable items)
- [ ] Show a short reason when an action is unavailable (already assigned, wrong status, not a team member)
- [ ] Assignee shows a name, not a raw ID (keep "Me" for the current user)
- [ ] Seed made realistic: `updated_at` spread over 30 days, about 20% of items with `due_at` (some overdue), resolved/closed items assigned
- [ ] Test: server rejects claim on a closed item with a clear error

## 1. Required behaviour (most important)

- [ ] **Idempotency key reuse:** one key per click, reused on retry, button disabled while pending. Check: double-click Claim fast, only one request is sent
- [ ] **409 message:** two browsers, two users, claim the same item. The loser sees a clear message with the current owner
- [ ] **Stale edit:** edit in browser A, change in browser B, save in A. A "changed by X, review" prompt appears, no silent overwrite
- [ ] **Cursor "load more"** at the bottom of the list, no duplicate rows

## 2. Dashboard and detail page

- [ ] Dashboard cards show non-zero counts (assigned to me, awaiting my approval, unassigned urgent, overdue/stale, recently changed)
- [ ] Each card links to the matching filtered list
- [ ] Detail page shows description, status, priority, owner, comments, paginated timeline
- [ ] Polling about every 20s plus refetch on window focus, with an "item updated, refresh" banner

## 3. Tests and the mutation check

```powershell
cd api
npx vitest run
```

- [ ] All tests pass (read the real output)
- [ ] Remove `assignee_id IS NULL` from the claim query, confirm the concurrent-claim test **fails**, then restore it
- [ ] Tests exist for: concurrent claims, stale version, idempotent replay, cross-team 404 / wrong-role 403, illegal transition, outbox atomicity, job run twice gives one notification, retry then dead, lease reclaim, keyset pagination stability

## 4. Docker compose

- [ ] `docker-compose.yml` exists and brings up postgres, api, worker, web with one command (`docker compose up`)
- [ ] Migrations and seed run automatically or are documented in the README

## 5. Docs

- [ ] **README.md:** prerequisites, exact run steps that actually work, seeded logins, how to run tests, project layout, assumptions, architecture diagram
- [ ] **ENGINEERING_DECISIONS.md:** rewritten in my own words. Five decisions, each with the trade-off:
  - [ ] Postgres-only design
  - [ ] Optimistic locking plus atomic claim
  - [ ] Outbox instead of a message queue
  - [ ] Central policy module for authorization
  - [ ] What I intentionally did not build
- [ ] **KNOWN_LIMITATIONS.md:** honest, matches what the code does. Includes "what I'd do with another week" and "what changes at 10x scale"
- [ ] The docs claim nothing the code doesn't do

## 6. Read the code and prepare for the review

For each item, be able to explain what happens if it fails halfway:

- [ ] Atomic claim (single conditional UPDATE)
- [ ] Version check and the 409 response
- [ ] Idempotency middleware (including two identical requests at once)
- [ ] Outbox transaction (item + event + job in one transaction)
- [ ] Worker (`FOR UPDATE SKIP LOCKED`, retries, dead jobs, lease reclaim)
- [ ] Policy module (cross-team 404, wrong role 403)
- [ ] One request traced end to end, from button click to database and back
- [ ] Practiced answers for: what happens when things fail, assumptions, what to change at 10x scale, what to do with another week

## 7. Final check and submit

- [ ] Commit everything
- [ ] Fresh clone into a new folder, follow my own README, confirm the app runs and the tests pass
- [ ] No secrets committed (`.env` with real values). `.env.example` present
- [ ] `.gitignore` covers `node_modules` and build output
- [ ] No dead code or stray files
- [ ] Submitted before **10:00 AM IST, 4 Oct 2026** (aim for well before)

---

## Notes

_Add problems found, decisions made, and things to mention in the interview here._

