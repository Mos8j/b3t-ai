# Architecture — Universal Client Application Automation System (UCAAS)

## Goals
One client at a time → profile → discover/import sites → rank → approve → automated form-fill → human-gated submission → evidence-backed reporting. Catalog scales to 1,000+ sites; no site is labelled "supported" until a recorded passing test exists.

## Components
| Component | Tech | Responsibility |
|---|---|---|
| `apps/web` | Next.js + TS | Dashboard, intake wizard, discovery review, queues |
| `apps/api` | TS (Fastify) | Auth, RBAC, REST API, audit logging, consent |
| `apps/worker` | TS + BullMQ + Playwright | Durable jobs: discovery, verification, form-fill |
| `packages/core` | TS (pure) | URL normalization, dedupe, field mapping, authorization policy, status state machine |
| `packages/discovery` | TS | Pluggable `SearchProvider`, `LlmClassifier`, `Verifier` modules |
| `packages/adapters` | TS | Adapter registry; generic form engine + site adapters; mock sites |
| PostgreSQL | | System of record, row-level client isolation |
| Redis | | BullMQ queues (durable, AOF on) |
| Object store (S3/MinIO) | | Private documents, short-lived signed URLs |

## Key design rules
1. **Evidence over claims.** Every discovered/verified fact stores `source` and `verified_by` (`check` | `ai` | `user` | `import`). AI classifications are flagged `ai_unverified` until a check confirms them.
2. **State machine for applications:** `queued → in_progress → form_filled → awaiting_approval → submitting → submitted → confirmed`; side states `awaiting_human`, `failed`, `skipped`, `cancelled`. `submitted` requires submission evidence; `confirmed` requires confirmation evidence (page text hash / confirmation number / email receipt reference).
3. **Authorization is separate from consent to hold data.** Submission requires a per-application or defined-batch approval; paid, legal declarations, marketing opt-ins each need their own explicit authorization. CAPTCHA/MFA/ID-verification always route to `awaiting_human`.
4. **Never invent.** Field mapper returns `missing` for anything not in the profile; screening questions only answered from approved templates.
5. **Client isolation:** every table with client data carries `client_id`; Postgres RLS + app-level checks; per-client encryption keys (envelope encryption with a KMS-held master key).
6. **Discovery is modular:** `SearchProvider` (Brave/Bing/SerpAPI/custom), official APIs (job-board APIs, etc.), `Verifier` (DNS/TLS/redirect/robots/ToS checks actually performed), `LlmClassifier` (provider-agnostic).
7. **Respect sites:** robots/ToS check recorded per site; `automation_policy` = `allowed | api_only | manual_only`. Manual-only sites yield guided handoff, never automation.

## Data flow
Intake → `client_profile` + `consent`. Import list → `site_import` → normalize/dedupe → `site` rows (originals preserved) → verification job → discovery job seeds from each site → `site_relation` suggestions (reason + confidence) → user accept/reject → `catalog`. Matching job scores `client × site` → ranked `match` rows → user selects → batch → `application` rows (unique on client+site) → worker runs adapter → status transitions with evidence → reports.

## Deployment
Docker Compose for local; containers for web/api/worker for prod; secrets via env/secret manager; structured JSON logs with PII redaction; Prometheus metrics endpoint.
