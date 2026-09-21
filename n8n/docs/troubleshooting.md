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

### 1. captureId must never contain a random part — resolved

`captureId` used to be `Date Created` + `__` + `Random Number`. The random part
regenerated on every run, so the same video produced a different key each time,
the upsert could never match, and re-sharing made a second row. Executions 2140
and 2141 are the proof: same video, same `Date Created`, suffixes `__718409` and
`__627695`, two pages created.

This mattered beyond duplicates. The upsert exists so the host capture agent,
ffprobe and the doorman can PATCH into a row that already exists — all of which
need a key that is stable for a given capture.

**Now:** `yyyyMMdd-HHmmss__<lowercase original name>`, e.g.
`20260921-093623__img_2631`. Both components are properties of the file, so the
same video yields the same key forever. Verified — posting that id twice returns
`created` then `updated` against one page.

**The rule:** nothing in captureId may vary between two sends of the same
capture. No random numbers, no `now()`, no counters. Derive every component from
the file itself.

### 2. Colons in filenames

captureId doubled as the filename during the ISO period, producing files named
`2026-09-21T09:36:23-05:00__124308.md`. Colons are legal in APFS at the POSIX
layer but Finder renders them as `/`, they are illegal on exFAT/SMB, and they
need quoting in every shell path. The `yyyyMMdd-HHmmss` format removes the
problem; the doorman still has to cope with the four legacy rows.

### 3. `Captured At` — two failures, both fixed

The original parser only matched the compact `YYYYMMDD-HHMM` prefix, so every row
created after the Shortcut switched to ISO had a null date. `parseCaptureStamp` now
accepts both and preserves the UTC offset. Deployed, and the three affected rows have
been backfilled.

## Timestamps and time zones

### A datetime with no offset is wrong by the zone's offset

Notion reads an offset-less datetime as **UTC**. A Central capture sent as the
naive string `2026-09-20T21:40:00` therefore landed on the page as 4:40 PM —
exactly 5 hours early, which reads like a plausible time rather than an obvious
bug. That is what makes this failure mode dangerous: nothing errors, and the
date looks reasonable.

Every datetime the workflow writes now carries an explicit offset, computed for
its own wall-clock instant via `Intl`, so DST is resolved rather than assumed:
`America/Chicago` is `-05:00` in July and `-06:00` in January. The zone is
`captureTimeZone` in the **Config** node — never hardcoded in the parser.

Symptom to watch for: a Captured At that is off by exactly 5 or 6 hours. That is
always a missing offset, never a rounding error.

### Notion truncates seconds — platform limit, not a bug here

The workflow emits full precision. `20260921-093623__img_2631` produces
`2026-09-21T09:36:23-05:00`, seconds intact. Notion stores `14:36:00Z` — correct
minute, seconds zeroed. Confirmed identically through the n8n HTTP path and the
Notion MCP, so it is the date property itself, not the workflow.

Seconds are not lost from the record: captureId carries them, and it is stored
verbatim in the Capture ID column. If a Notion view ever needs second precision,
it has to come from that column, not from Captured At.

### Container time zone is not Central

Probed on the executing process:

```json
{ "GENERIC_TIMEZONE": "America/Los_Angeles",
  "TZ":               "America/Los_Angeles",
  "EXECUTIONS_MODE":  "queue",
  "node_tz":          "America/Los_Angeles" }
```

**Captured At is unaffected** — the code passes `captureTimeZone` to `Intl`
explicitly, so it never consults the container zone.

It does affect everything else that touches dates: Schedule Trigger cron times,
`$now`, `$today`, and date formatting in any other node all run on Pacific. For
the audit loop, a "9am" schedule would fire at 11am Central. Worth aligning
before that gets built.

Caveat on the probe: in queue mode the expression evaluates on whichever worker
ran it, so this reflects a worker, not necessarily the main or webhook process.
Confirming those needs shell access to the host.

## Doorman — capture ID matching

The regex `^\d{8}-\d{4}__\d{6}` matches none of the formats now in use. It
requires exactly six digits after the separator, which was only ever true of the
retired random-suffix scheme.

Going forward, match only the current format:

```
^\d{8}-\d{6}__[a-z0-9._-]+$
```

While the four legacy rows still exist, this accepts all three shapes:

```
^(?:\d{8}-\d{6}|\d{8}-\d{4}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)__[A-Za-z0-9._-]+$
```

Treat the four legacy rows plus `20260921-093623__img_2631` as test data — they
predate the stable-key format and can be deleted once the doorman is real.

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
