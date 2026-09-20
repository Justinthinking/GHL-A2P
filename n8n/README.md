# iOS Shortcut → Notion Capture Inbox

An n8n workflow that catches a POST from an iOS Shortcut and files it as a page in a
Notion database, with the transcript as page body.

Workflow: [`workflows/ios-capture-to-notion.json`](workflows/ios-capture-to-notion.json)
Target database: **Capture Inbox** — https://app.notion.com/p/be0733d869a0443db517dc35d798a36d

## Request contract

`POST <webhook-url>` with `Content-Type: application/json`:

```json
{
  "captureId": "20260920-1731__a7k2m9",
  "title": "This is the first sentence of the video transcript",
  "transcript": "This is the full text of the video...",
  "device": "iPad M5 Pro",
  "duration": "20.5",
  "size": "15432000"
}
```

| Field | Required | Notes |
|---|---|---|
| `captureId` | yes | Doubles as the idempotency key. A `YYYYMMDD-HHMM` prefix is parsed into **Captured At**. |
| `title` | no | Falls back to the transcript's first sentence. Truncated to 200 chars. |
| `transcript` | no | Written to the page body, chunked into ≤1900-char paragraph blocks. |
| `device` | no | New devices become new select options automatically. |
| `duration` | no | Seconds. Strings are coerced; junk becomes empty, not `0`. |
| `size` | no | Bytes in, megabytes stored. |

At least one of `title` or `transcript` must be present.

## Responses

| Code | `status` | Meaning |
|---|---|---|
| 201 | `created` | New page. Body carries `pageId` and `pageUrl`. |
| 200 | `duplicate` | This `captureId` already exists; returns the original page. |
| 400 | `invalid` | Body carries an `errors` array naming each missing field. |
| 502 | `notion_error` | Notion rejected the write; body carries Notion's message. |

## Setup

1. **Import** the workflow JSON (n8n → Workflows → Import from File).
2. **Credential** — create a Notion API credential from an
   [internal integration](https://www.notion.so/my-integrations) token, then select it on the
   three HTTP Request nodes (*Find Existing Capture*, *Create Notion Page*, *Append Overflow Blocks*).
3. **Share the database** with that integration: open Capture Inbox → `⋯` → Connections → add it.
   Skipping this is the usual cause of a 404 from Notion.
4. **Activate**, then copy the *production* webhook URL from the Capture Webhook node.

Pointing this at a different database means editing one field: `notionDatabaseId` in the
**Config** node. Nothing else references the ID.

## The Shortcut side

1. Record / pick the video → **Transcribe** (or Whisper via an API step).
2. **Text** action, `Capture ID`: `[Current Date, formatted yyyyMMdd-HHmm]__[random suffix]`.
3. **Dictionary** action with the six keys above.
4. **Get Contents of URL** → Method `POST`, Request Body `JSON`, body = the dictionary.
5. Optional: **Get Dictionary Value** `pageUrl` from the response → **Open URL**, so the page
   opens the moment it lands.

Keep the `captureId` stable across retries — that is what makes a flaky-signal re-send land as
`duplicate` instead of a second row.

## Design notes

**Why raw HTTP Request nodes instead of the Notion node.** The Notion node's block list is a
static UI field, so it cannot write a variable number of transcript blocks. A transcript longer
than Notion's 2000-char-per-block limit has to be chunked at runtime, which means building the
`children` array in code and POSTing it. All three nodes use the same stock `notionApi`
credential, so there is no extra setup cost for this.

**Ceiling.** Notion accepts 100 children on create and 100 more on append. That puts the hard
limit at ~195 paragraph blocks, roughly 370k characters or 60k words. Past that the page carries
a visible truncation notice rather than losing text silently.

**Failure paths.** Every branch terminates at a Respond node, so the Shortcut always gets a
structured JSON body — never a bare 500 or a hung request.

## Extending

The obvious next links in the chain, all inserted between *Normalize Capture* and
*Create Notion Page*:

- an LLM node that writes a summary, pulls action items, and sets **Status** to `Triaged`
- a classifier that tags captures by theme and routes them to the right downstream database
- an audio-file branch that uploads the source clip to the page as an attachment
