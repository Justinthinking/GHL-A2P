# Capture pipeline — troubleshooting runbook

Workflow `NrlKMTTuzCiOZqCg` · endpoint `POST https://dfn8n.xyz/webhook/capture`
Database: [Capture Inbox](https://app.notion.com/p/be0733d869a0443db517dc35d798a36d)

## Status — the pipeline works

As of execution 2142 the path is end-to-end green. Four captures in Notion with
Duration, Size, Word Count, Device, Filename and transcript bodies all populated.

| Exec | Result | Duration | Size | Words |
|---|---|---|---|---|
| 2142 | created | 427 s | 290.8 MB | 761 |
| 2141 | created | 241 s | 461.4 MB | 464 |
| 2140 | created | 241 s | 461.4 MB | 464 |
| 2136 | created | 1519 s | 843.9 MB | 2188 |
| 2134 | created | 164 s | 310.2 MB | 303 |

What got it there, in order: Header Auth credential replacing the env-var gate;
the Notion integration ("Local SQL bot") shared with the database; `mm:ss` and
`"310.2 MB"` parsers.

## Diagnose any run in three commands

You do not need the n8n UI. With `$K` as your n8n API key:

```bash
# 1. Which executions ran, and did they finish?
curl -s -H "X-N8N-API-KEY: $K" \
  "https://dfn8n.xyz/api/v1/executions?workflowId=NrlKMTTuzCiOZqCg&limit=5" | jq '.data[]|{id,status,startedAt}'

# 2. Where did a specific run stop? This single field answers most questions.
curl -s -H "X-N8N-API-KEY: $K" \
  "https://dfn8n.xyz/api/v1/executions/<ID>?includeData=true" | jq '.data.resultData.lastNodeExecuted'

# 3. What did the device actually send?
curl -s -H "X-N8N-API-KEY: $K" \
  "https://dfn8n.xyz/api/v1/executions/<ID>?includeData=true" \
  | jq '.data.resultData.runData["Capture Webhook"][0].data.main[0][0].json | {headers,body}'
```

`lastNodeExecuted` is the fastest diagnostic in the system. Read it first, always.

## Symptom → cause

### Nothing in Notion, and no execution appears at all

n8n rejected the request before the workflow started. Header Auth failures do **not**
create executions — this is the one failure mode invisible in the execution list.

- Missing or wrong `X-Capture-Token` header → n8n returns `403 Authorization data is wrong!`
- Confirm with: `curl -i -X POST https://dfn8n.xyz/webhook/capture -H 'Content-Type: application/json' -d '{"captureId":"test"}'`
  A 403 means the endpoint is alive and the gate is doing its job.
- Workflow deactivated or archived → the URL 404s instead.

### `lastNodeExecuted: Respond — Invalid` (HTTP 400)

The body parsed but `captureId` was empty or absent. Response names the field.
Usually the Text action producing captureId resolved to nothing.

### `lastNodeExecuted: Respond — Notion Error` (HTTP 502)

Notion rejected the call. The response body carries Notion's own message. Common ones:

| Notion says | Means |
|---|---|
| `Could not find database with ID … share with your integration "X"` | The integration is not connected to the database. Notion → `⋯` → Connections. |
| `X is not a property that exists` | Schema drift — a property was renamed or deleted. |
| `Invalid select option` | A select value not in the option list. Device is mapped defensively; other selects are not. |
| `rate_limited` | Burst. The nodes retry 3× at 2 s automatically; a surviving 429 means sustained load. |

### `lastNodeExecuted: Respond — Created` but nothing visible in Notion

The page was created and later trashed, or you are looking at a filtered view.
Get the page id from the execution and check it directly:

```bash
curl -s -H "X-N8N-API-KEY: $K" "https://dfn8n.xyz/api/v1/executions/<ID>?includeData=true" \
  | jq '.data.resultData.runData["Create Notion Page"][0].data.main[0][0].json | {id,url,archived}'
```

### A column is empty but the row exists

Silent property drops are by design — a malformed value is omitted rather than
failing the whole write. Check what the parser received in the webhook body (command 3
above). Known formats handled: duration `2:44` / `1:02:03` / `20.5`; size
`310.2 MB` / `1.2 GB` / raw bytes; captureId ISO or compact.

### Duplicate rows for one video

See the open issue below. This is currently expected behaviour, not a fault.

## Open issues

### 1. The random suffix defeats idempotency — highest priority

`captureId` is built as `Date Created` + `__` + `Random Number`. Date Created is
stable for a given video; the random number is regenerated on every run. So the
same video shared twice produces two different captureIds, the upsert never
matches, and you get two rows.

**This already happened.** Executions 2140 and 2141 both carry Date Created
`2026-09-21T09:09:12-05:00` — the same video, 1.5 minutes apart — with suffixes
`__718409` and `__627695`. Both created pages. One was deleted by hand afterward.

The entire upsert design rests on captureId being stable for a given capture. With a
random component it can never be, which also means the host capture agent, ffprobe
and the doorman have no reliable key to PATCH against later.

**Fix:** delete the `Random Number` action and the `__[Random Number]` part of the
Text action. Leave captureId as the bare ISO timestamp. Second-level precision on a
per-device capture is already collision-safe — two videos cannot share a creation
second on one device. If you want belt-and-braces, append something derived from the
file (original filename) rather than something random.

### 2. Colons in filenames

captureId doubles as the filename, so files are now named
`2026-09-21T09:36:23-05:00__124308.md`. Colons are legal in APFS at the POSIX layer
but Finder renders them as `/`, and they are illegal on exFAT/SMB and awkward in
shell paths without quoting. The Mac-side doorman will have to handle this.

Consider a filename-safe variant — `yyyyMMdd-HHmmss` — while keeping the ISO form in
the `capturedAt` body field for the date property. That gives clean filenames and a
precise timestamp, and restores compatibility with the original compact format.

### 3. `Captured At` was empty on ISO captureIds — fixed

The original parser only matched the compact `YYYYMMDD-HHMM` prefix, so every row
created after the Shortcut switched to ISO had a null date. `parseCaptureStamp` now
accepts both and preserves the UTC offset. Deployed, and the three affected rows have
been backfilled.

## Response reference

Add **Show Result → Contents of URL** as the last Shortcut action and keep it. Every
response is structured JSON:

| Code | Body | Meaning |
|---|---|---|
| 201 | `{ok:true, status:"created", pageId, pageUrl}` | New row |
| 200 | `{ok:true, status:"updated", pageId, pageUrl}` | Existing captureId, properties patched |
| 400 | `{ok:false, status:"invalid", errors:[…]}` | captureId missing |
| 502 | `{ok:false, status:"notion_error", message}` | Notion rejected the write |
| 403 | `Authorization data is wrong!` (plain text) | Header Auth — no execution recorded |

## Invariants worth not breaking

- **Database ID lives only in the Config node.** Nothing else references it.
- **`Status` and `Source` are written on create only.** A re-POST cannot reset a
  hand-edited Status. This is deliberate and load-bearing for the doorman stage.
- **Page children are never rewritten on update.** Blocks append only when the body
  sets `appendBlocks: true`, otherwise a re-send would duplicate the transcript.
- **An absent body key leaves Notion untouched; an explicit `null` clears it.**
