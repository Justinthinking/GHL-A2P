# Execution 2129 — why nothing reached Notion

Pulled from the n8n API (`GET /api/v1/executions/2129?includeData=true`) on 2026-09-21.
Workflow `NrlKMTTuzCiOZqCg`, active, mode `webhook`.

## Verdict

**The request was rejected by the auth gate. It never got near Notion.**

```
lastNodeExecuted: Respond — Unauthorized
```

Three nodes ran, then it stopped:

| # | Node | Result |
|---|---|---|
| 1 | Capture Webhook | success — payload received intact |
| 2 | Authorized? | success — evaluated **false** |
| 3 | Respond — Unauthorized | success — returned HTTP 401 |

n8n reports the execution `status: success` because the workflow did exactly what it
was built to do: it refused an unauthenticated request and answered cleanly. A green
execution is not a delivered capture.

### This is not new — it is every run

All ten executions on record ended identically:

```
2129  Respond — Unauthorized   token=False   body=full payload
2128  Respond — Unauthorized   token=False   body=empty
2127  Respond — Unauthorized   token=False   body=empty
2126  Respond — Unauthorized   token=False   body=empty
2123  Respond — Unauthorized   token=False   body=empty
2122  Respond — Unauthorized   token=False   body=empty
2121  Respond — Unauthorized   token=False   body=empty
2120  Respond — Unauthorized   token=False   body=empty
2119  Respond — Unauthorized   token=False   body=empty
2118  Respond — Unauthorized   token=False   body=empty
```

Capture Inbox is empty because **no execution has ever reached the Notion nodes.**
2129 is the first run carrying a real payload; the rest were empty-body taps.

## Root cause

The Shortcut sends no `x-capture-token` header. Full header list as received:

```
accept, accept-encoding, accept-language, cdn-loop, cf-connecting-ip,
cf-ipcountry, cf-ray, cf-visitor, cf-warp-tag-id, connection,
content-length, content-type, host, priority, user-agent,
x-forwarded-for, x-forwarded-proto
```

No `x-capture-token`. The gate requires two conditions to both hold:

1. `$env.CAPTURE_TOKEN` is non-empty
2. `$json.headers['x-capture-token']` equals it

Condition 2 fails on an absent header regardless of condition 1, so this 401s whether
or not `CAPTURE_TOKEN` is set on the container. Both still need to be true to pass.

## What the body proves

The payload arrived **perfectly formed**. This rules out the file-vs-JSON theory
entirely — no Shortcut body change is needed.

```
content-type: application/json
content-length: 1807
user-agent: BackgroundShortcutRunner/4610 CFNetwork/3860.600.12 Darwin/25.5.0
```

Parsed body, all six keys present:

| Key | Value |
|---|---|
| `captureId` | `20260920-2140__170168` |
| `title` | `" This is just a couple mini video to go over..."` |
| `transcript` | full transcript, ~1.6 KB |
| `device` | `iPad M5 Pro` |
| `duration` | `2:44` |
| `size` | `310.2 MB` |

## Two latent bugs the 401 is currently hiding

Fix the header and these surface immediately as silently-empty columns.

### `duration` arrives as `"2:44"`, not seconds

The Shortcut's Duration chip yields `mm:ss`. `Number("2:44")` is `NaN`, so
`toNumber` returns `null` and **Duration (s) is omitted from the Notion write.**
No error — the column just stays blank.

### `size` arrives as `"310.2 MB"`, not bytes

The File Size chip yields a formatted string. `Number("310.2 MB")` is `NaN`, so
**Size (MB) is omitted too.** The original contract specified bytes; the Shortcut
cannot produce them from that chip.

### Patch for `Normalize Capture`

Handles both formats without breaking the documented bytes-and-seconds contract:

```js
// "2:44" | "1:02:03" | "20.5" -> seconds
const parseDuration = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s.includes(':')) return toNumber(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

// "310.2 MB" | "1.2 GB" | "15432000" (bare = bytes) -> megabytes
const UNIT_MB = { b: 1 / 1048576, kb: 1 / 1024, mb: 1, gb: 1024, tb: 1048576 };
const parseSizeMb = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).trim().match(/^([\d.,]+)\s*([kmgt]?b)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  return Math.round((unit ? n * UNIT_MB[unit] : n / 1048576) * 100) / 100;
};
```

Then swap the two call sites:

```js
if (has('duration')) {
  const seconds = parseDuration(body.duration);
  setBoth('Duration (s)', seconds === null ? CLEAR.number : { number: seconds });
}
if (has('size')) {
  const mb = parseSizeMb(body.size);
  setBoth('Size (MB)', mb === null ? CLEAR.number : { number: mb });
}
```

Expected after patch: `2:44` → `164`, `310.2 MB` → `310.2`.

## Third gap: `filename` is never sent

The Dictionary has six keys and `filename` is not one of them. The `Filename` column
now exists in Notion but will stay empty until the Shortcut sends it. The Shortcut
already knows the value — it is the same `Text` chip used to name both saved files
(`20260920-2140__170168`). Add a seventh Dictionary row:

```
filename   ->   [Text] chip   (append .mov / .md as appropriate)
```

## Fix order

1. **Set `CAPTURE_TOKEN`** in the n8n container env, restart n8n.
2. **Add the header** in Get Contents of URL → Headers: `X-Capture-Token` = that value.
3. Re-run. Expect `201 created` and a Capture Inbox row.
4. Apply the duration/size patch so those two columns populate.
5. Add `filename` to the Dictionary.

### Make failures visible from the device

Add **Show Result** → **Contents of URL** as the last Shortcut action. Every response
from this workflow is structured JSON, so the device shows you the reason directly:

```json
{ "ok": false, "status": "unauthorized" }
{ "ok": false, "status": "invalid", "errors": ["captureId is required"] }
{ "ok": true,  "status": "created", "pageUrl": "https://notion.so/..." }
```

Worth keeping permanently.

## Unrelated, still blocking the wider goal

The video is **310.2 MB** and every file in iCloud Drive reads `Error — upload`.
Per the plan in the transcript, the Mac picks the file up from iCloud, confirms the
upload, and flips Status in Notion. That handoff cannot work while iCloud sync is
failing. Notion ingest and iCloud sync are independent problems — fixing the header
gets rows landing regardless.
