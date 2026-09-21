# Audit — why the Shortcut is not pushing rows into Notion

Evidence gathered 2026-09-21 from the n8n API (executions 2118–2131), a live
environment probe, and a direct query against the Capture Inbox data source.

## Verdict

**Two independent blockers, both in the auth gate. Neither is in your Shortcut's data.**

| # | Blocker | Where | Status |
|---|---|---|---|
| 1 | `CAPTURE_TOKEN` is not set on the n8n container | VPS | **Confirmed unset** |
| 2 | Shortcut sends no `x-capture-token` header | iPad | **Confirmed absent** |

The gate ANDs two conditions. **Fixing either one alone still returns 401.** Both
must clear in the same run. This is the single most important fact in this document —
it is the trap that makes it feel like nothing you change has any effect.

## Evidence

### Execution 2131 stopped three nodes in

```
lastNodeExecuted: Respond — Unauthorized
status: success        <- the workflow succeeded at refusing the request

Capture Webhook          success
Authorized?              success   (evaluated false)
Respond — Unauthorized   success   (HTTP 401)
```

Identical for 2129, 2128, 2127, 2126, 2123, 2122, 2121, 2120, 2119, 2118. Eleven
consecutive runs, every one stopped at the same node. **No execution has ever reached
a Notion node.**

Note the `success` status. n8n is reporting that the workflow did its job — it
refused an unauthenticated request and answered cleanly. Green executions plus an
empty database is precisely what a working auth gate looks like. Do not read green
as delivered.

### The header is not arriving

Complete header list from 2131, verbatim:

```
accept, accept-encoding, accept-language, cdn-loop, cf-connecting-ip,
cf-ipcountry, cf-ray, cf-visitor, cf-warp-tag-id, connection,
content-length, content-type, host, priority, user-agent,
x-forwarded-for, x-forwarded-proto
```

The only `x-` headers are Cloudflare's own. Nothing token-shaped, nothing
auth-shaped. The Shortcut's Get Contents of URL action has no Headers configured.

### The env var is not set

Probed with a temporary workflow (created, called, deleted):

```json
{ "capture_token_set": false, "length": 0 }
```

`$env.CAPTURE_TOKEN` resolves to empty on the running container. Condition 1 of the
gate fails on its own — which means **adding the header alone will not fix this.**

### Notion is genuinely empty

```sql
SELECT "Capture ID", "Name", "Status" FROM "Capture Inbox" ORDER BY "Ingested At" DESC
-- 0 rows
```

Not a permissions problem, not a wrong-database problem. Nothing has been written
because nothing has been attempted.

## What is already working

Worth stating plainly, because the Shortcut is in better shape than the symptom suggests:

- Transcription runs and produces real text (~1.6 KB)
- `captureId` generates correctly: `20260920-2140__403540`
- Both files save with matching names (`.md` and the video)
- **`filename` was added to the Dictionary since 2129** — it is arriving now
- Body serialises correctly: `content-type: application/json`, 1842 bytes, parsed
  cleanly into all seven keys

The earlier suggestion to switch the request body from File to JSON was wrong and
should be ignored. The body has been correct the whole time.

Payload received in 2131:

| Key | Value |
|---|---|
| `captureId` | `20260920-2140__403540` |
| `filename` | `20260920-2140__403540` |
| `title` | `" This is just a couple mini video..."` |
| `transcript` | full text |
| `device` | `iPad M5 Pro` |
| `duration` | `2:44` |
| `size` | `310.2 MB` |

## Fixing it

Two routes. Pick one — they are alternatives, not steps.

### Route A — native Header Auth (recommended)

Drop the custom gate and use the Webhook node's built-in authentication. You already
run several `httpHeaderAuth` credentials in this instance, so this is your existing idiom.

1. n8n → Credentials → New → **Header Auth**. Name `Capture Token`.
   Header Name `X-Capture-Token`, Header Value = a secret you generate.
2. Open the Capture Webhook node → Authentication → **Header Auth** → that credential.
3. Delete `Authorized?` and `Respond — Unauthorized`; wire Capture Webhook → Config.
4. Add the header in the Shortcut (steps below).

Why this is better here:

- **No container restart.** The secret lives encrypted in n8n's database.
- **No secret in git.** The env route puts it in docker-compose; this does not.
- Two fewer nodes, and n8n rejects before the workflow body runs.

Trade-off: rejected calls get n8n's own 403 with no JSON body, and no execution is
recorded. You lose the friendly `{"ok":false,"status":"unauthorized"}` response.

### Route B — keep the current gate

1. Add `CAPTURE_TOKEN=<secret>` to the n8n service environment in `docker-compose.yml`.
2. `docker compose up -d` to recreate the container. **This restarts n8n** and kills
   any in-flight executions.
3. Confirm `N8N_BLOCK_ENV_ACCESS_IN_NODE` is not `true`, or `$env` reads empty
   regardless of what you set.
4. Add the header in the Shortcut (below).

Keeps the structured 401 body and the execution record for every rejected call.

### The Shortcut half — required either way

In **Get Contents of URL**:

1. Tap the **`>`** chevron on the action to expand it. The Headers section is hidden
   until you do — this is almost certainly why it was missed.
2. Method is already POST. Under **Headers**, tap **Add new header**.
3. Key: `X-Capture-Token`  ·  Value: the same secret.
4. Leave Request Body as **JSON** with the existing Dictionary. Change nothing there.

Header names are case-insensitive; `X-Capture-Token` and `x-capture-token` both match.

## Still ahead once auth clears

Both of these land as **silently empty columns** — no error, no failed execution.

### `duration: "2:44"` → Duration (s) will be blank

`Number("2:44")` is `NaN`, so the property is dropped from the write.

### `size: "310.2 MB"` → Size (MB) will be blank

The File Size chip emits a formatted string, not bytes. Same silent drop.

Both parsers are written out in
[`execution-2129.md`](execution-2129.md#patch-for-normalize-capture). The fix is
confined to the `Normalize Capture` code node — no structural change.

## Verifying the fix

Add **Show Result** → **Contents of URL** as the final Shortcut action and keep it
permanently. Every response from this workflow is structured JSON, so the device
tells you the outcome instead of failing silently:

```json
{ "ok": true,  "status": "created", "pageId": "...", "pageUrl": "https://notion.so/..." }
{ "ok": false, "status": "unauthorized" }
{ "ok": false, "status": "invalid", "errors": ["captureId is required"] }
{ "ok": false, "status": "notion_error", "message": "..." }
```

Success looks like: HTTP 201, `status: created`, and a row in Capture Inbox with
Status `Inbox`, Source `iOS Shortcut`, and the transcript in the page body.

Expect Duration and Size to be empty on that first successful run. That is the
known parser bug above, not a new failure.
