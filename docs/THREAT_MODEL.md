# Threat Model

| # | Threat | Mitigation |
|---|---|---|
| 1 | Cross-client data leakage | `client_id` on all rows, Postgres RLS, per-client DEKs, tests asserting isolation |
| 2 | Unauthorized staff access | RBAC (admin/operator/viewer), per-client assignment, access-history audit log |
| 3 | PII in logs/URLs/screenshots | Redaction middleware, no PII in routes, screenshots disabled for forms w/ PII or masked |
| 4 | Document theft | Private bucket, expiring signed URLs, virus scan, type/size limits |
| 5 | Phishing/lookalike sites receiving client data | Verifier: domain age/TLS/redirect checks, official-domain preference, allowlist approval before any fill |
| 6 | Prompt injection from scraped pages into LLM | LLM output only classifies; never executes actions; strict JSON schema; no tool access |
| 7 | Unintended submissions/charges | Authorization policy gate in worker; paid flows blocked without explicit billing authorization |
| 8 | Fabricated answers | Mapper returns `missing`; only approved templates for screening Qs |
| 9 | Secret leakage | Env/secret manager, never committed; `.env.example` only |
| 10 | Queue replay / duplicate applications | Unique (client, site) constraint + idempotency keys |
| 11 | ToS / anti-bot violations | Per-site `automation_policy`, rate limits, no CAPTCHA/MFA bypass |
| 12 | Data over-retention | Configurable retention, scheduled secure deletion, export |
| 13 | AI field-mapping error or prompt injection | Optional mapper sees only bounded field labels/metadata and existing safe profile key names, has no tools, returns strict allow-listed key suggestions, and cannot draft answers. Existing approval and sensitive-field gates still apply; failures fall back to rule-based mapping. |

## Page checks (server fetches web pages)
- Only http/https; addresses inside your computer or network are refused (SSRF). Limitation: DNS is checked before the request, so a hostile site that changes its DNS answer in between could slip past. Run it on a trusted machine and only for admin/operator accounts.
- 10 second timeout, 1.5 MB cap, 4 redirects, robots.txt respected, honest User-Agent. CAPTCHAs and blocks are never bypassed; they mark a site "staff".
- If most of a batch cannot connect, nothing is recorded (avoids removing good sites when your internet is down).
