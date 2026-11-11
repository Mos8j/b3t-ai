# Development Plan

Status legend: [x] done & tested, [~] partly built, [ ] not started

## Stage 0 — Foundations
- [x] Architecture, threat model, plan
- [x] Repo scaffold, Docker compose, DB migrations (001, 002) with a migration runner (`npm run db:migrate`)
- [x] `packages/core`: URL dedupe, field mapper, submission policy, status machine (tests pass under vitest on user's PC)

## Stage 1 — MVP
1. [~] Auth + RBAC: login/logout, sessions, lockout, roles, audit log, first-admin setup built and tested with in-memory storage (`apps/api`). Not yet run against the real database. Row-level security is defined but not enforced yet because the app connects as the database owner.
2. [~] Client profiles: encrypted create/read/edit/delete, consent records, validation, missing-info alerts, basic browser page. Multi-step wizard, documents upload, not built.
3. [~] Website-list import: CSV / text / bookmark-HTML parsing, duplicate flagging, CSV export built (`packages/importer`). Directory page (upload, search, filter, remove/restore) and database import built; the import SQL was checked against PostgreSQL 16 by hand, but the full app has not run against a real database here. Excel (.xlsx) import is not built.
4. [ ] Directory search/filter
5. [ ] Discovery engine (provider interface, verifier, LLM classifier, relations)
6. [ ] Matching/ranking
7. [ ] Playwright framework + mock sites + generic form engine
8. [~] Approval/authorization rules (core policy: submit / billing / legal / marketing / credit_inquiry grants, human-typed sensitive fields). Workflow UI not built.
9. [ ] BullMQ queue + dashboard
10. [ ] E2E tests + docs

## Stage 2 — Real integrations in verified batches (driven by your site list)
Each batch: adapter + recorded test run + ToS/robots review → only then `compatibility_status = supported`.

User's list (data/): 980 bookmarks -> 963 after removing 17 on 13 dead domains; 21 sites need a new signup URL; 8 quarantined for certificate errors.

Directory capacity and discovery (built, tested here with pretend websites only; not yet run against real sites):
- [~] Page check: reads a site's sign-up page (static HTML only), labels it "no staff needed", "staff do by hand" (CAPTCHA, sensitive numbers, login wall); sites that need a payment or a file upload are dropped and never added or "unclear". JavaScript-built forms come back "unclear".
- [~] Staff-first ordering and a staff view.
- [~] 2500-slot directory: candidate pool, "fill empty slots", automatic replacement of removed sites with the most similar candidate (similarity = overlap of form shape, not a promise it will work).
- [~] Search provider interface with Brave. Untested against the live service.
- [ ] Browser-based check for JavaScript forms (Playwright) and real form tests. Replacements join as "unverified" and are never applied to clients until tested.

## Browser check (unclear and blocked sites)
Button "Check unclear and blocked sites in a browser". Uses Playwright (installed by `npm.cmd install`) with Edge, Chrome or Chromium. It only looks: no clicks on submit, no downloads, at most one same-site sign-up link followed by GET. Sites that still block us stay "staff" ("never bypassed"). If no browser starts, run `npx.cmd playwright install chromium`.

## Sites for each client
Migration 005 adds `client_site`. On a client page, "Suggest sites" adds up to the client's chosen number (or all), staff-only sites first; skipped sites do not count and are not suggested again. For a staff-only site, staff choose "Staff will fill this" or "Skip"; for other sites "Approve" or "Skip". "Marked done" is typed by a person with a note and is not verified by the software. Nothing is submitted to any website yet.

## Form filling (packages/filler)
`createFiller().prepare(url, profile)` opens the page in a real browser. If the saved page is a landing page, it may follow up to three likely sign-up links on the exact same host using GET only; it never clicks a button or follows an external host. It then fills boxes it can match to stored client data, takes a screenshot and STOPS. Before sending, it may dismiss an overlay only through a clear close/dismiss control that does not contain a CAPTCHA; if another signup form still covers the reviewed form, it stops and asks staff to close and review again. Optional OpenAI-assisted field mapping can resolve unclear labels, but only to an existing, non-sensitive profile key; it receives field labels/metadata and key names, never profile values, has no tools, cannot draft answers, and its suggestions are shown separately for staff review. Disable it by leaving `LLM_PROVIDER=none`; to enable it set `LLM_PROVIDER=openai`, `LLM_API_KEY`, and optionally `LLM_MODEL`. `submit()` runs only after a person approved. The filler never ticks checkboxes, never types sensitive numbers, refuses payment and file-upload forms, hands CAPTCHAs and "verify you are human" screens to staff, and reports `confirmed` only when the page shows a success message (otherwise `sent_unconfirmed`, `confirm_email`, `failed` or `blocked`). Evidence text has client details removed.

### Boxes, usernames and passwords
The filler ticks a checkbox only when the client's recorded permission covers it: `accept_site_terms` (clearly named terms/privacy documents, or age confirmation when the date of birth on file allows), `marketing_opt_in` (clearly promotional offers/newsletters). Generic agreement wording, ambiguous communications, combined terms and marketing, negative/opt-out language, money, trials or renewals, sharing with partners, phone/text marketing, and "I am not a robot" go to a person or stay unticked. The checkbox decision uses the combined visible label and control name/id. It makes up a username and a long random password only with the `create_accounts` permission AND a way to save the login (`saveLogin`, called just before sending; if saving fails nothing is sent). The caller must store logins encrypted per client; that storage is not built yet.

### Login vault (admins only)
Migration 006 adds `client_login`. Every username and password the software makes for a client is sealed with that client's own key (`encryptLogin`) and saved just before a form is sent. Only admins (`login:read`) can open the list, on the client page ("Logins made for this client"); passwords are hidden until "Show" is pressed, and each time the list is opened a `logins.read` entry (without the passwords) goes to the activity log. Not yet connected to the filler's `saveLogin`; that comes with the screens.

### Prepare, approve, send (connected)
Client page, approved no-staff site: **Prepare** opens the page, fills it (only with what the client allowed, see "What this client has allowed"), shows a picture, and waits. **Approve and send** sends it once (a prepared form expires after 15 minutes and cannot be sent twice). Results are saved on the site line: `done` only when the page showed a success message; `sent` (not confirmed / email confirmation needed); unchanged `approved` when the site rejected the form; `skipped` when the site turned out to need payment or an upload; `staff_fill` when it asked for a human check. New logins are saved to the admin vault just before sending; if saving fails nothing is sent. Migration 007 adds the `sent` status.
