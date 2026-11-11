# Saved submission results

Each client has a Submission results panel with a delivery filter, attempt counts, paginated result cards, site evidence where available, and a recovery action. It refreshes between batches as well as after a preview or individual send. New attempts are recorded after this update; previous site notes are preserved.

## Delivery certainty

- `confirmed`: the filler reports a site confirmation.
- `not_sent`: preparation stopped or the filler explicitly reports that no sending action started.
- `unconfirmed`: an action may have sent the form, an email confirmation is needed, an existing membership was reported, or the final result is uncertain.

`SubmitResult.attempted` is false only before any action that could submit. A click timeout does not fall through to a second submit method. An error after a send starts is held for verification, rather than returned to the automatic approved queue. Staff must acknowledge checking before allowing another attempt.

## Storage and access

Structured results are stored as `submission.result` events in the existing `audit_log`, separate from the shortened site note. No database migration is required. A pending result is saved before the software calls submit, so an interrupted process leaves a visible result to verify. An `attemptId` lets a final result replace the pending or timed-out result for the same attempt in the result view and counts, while retaining all audit events.

`GET /api/clients/:id/results?delivery=unconfirmed&limit=10&offset=0` returns `{ total, counts, entries }`. Delivery is optional, limit is capped at 50, and entries are newest first. The API checks client read access and applies the same staff-site visibility rule as the client site list. It does not return unrelated audit events, credentials, or filled profile values. Evidence uses the filler's scrubbed excerpts with contact-data redaction before storage. No filled-form screenshot is stored in this history.

The PostgreSQL adapter selects the latest audit event per attempt. The memory adapter implements the same semantics for practice tests. Removing a site from active lists does not erase its saved result history.

## Checks

`apps/api/src/submission-results.test.ts` covers classification, evidence contact redaction, client isolation, staff visibility, pagination, and final-result replacement. The API tests cover the history endpoint, failed previews, and interrupted submissions. `packages/filler/src/submit-certainty.test.ts` verifies that uncertain send actions do not fall through to another submit method. The existing browser practice-form test exercises actual fill and submit behavior.
