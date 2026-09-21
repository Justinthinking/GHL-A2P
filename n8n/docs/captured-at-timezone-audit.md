# Audit — Captured At is five hours early, or blank

Evidence gathered 2026-09-21 from the Capture Inbox table, the iOS Photos Info
panel for `IMG_2658`, and a replay of `Normalize Capture` against the three live
capture IDs.

## Verdict

**Two failures, not one.** They look like the same bug because they hit the same
column, but they come from different code paths and the rows split cleanly by
which `captureId` format the Shortcut was sending at the time.

| Row (Capture ID) | Captured At | Cause |
|---|---|---|
| `20260920-2140__587698` | Sep 20, 4:40 PM — **5h early** | Naive datetime sent to Notion; Notion read it as UTC |
| `2026-09-20T16:44:08-05:00` | **empty** | The fallback regex never matched an ISO captureId |
| `2026-09-21T09:09:12-05:00` | **empty** | Same |

Neither failure was in the Shortcut's data. `20260920-2140` and
`2026-09-21T09:09:12-05:00` both carried the right instant — the workflow lost it.

## Failure 1 — the five-hour slide

`Normalize Capture` derived Captured At from the `YYYYMMDD-HHMM` prefix and sent
the result with no UTC offset:

```js
const parsedAt = `${y}-${mo}-${d}T${h}:${mi}:00`;   // "2026-09-20T21:40:00"
createProperties['Captured At'] = { date: { start: parsedAt } };
```

Notion reads an offset-less datetime as UTC, then renders it in the viewer's
zone. Central Daylight Time is UTC−05:00, so 21:40 UTC renders as 16:40 CDT.
Replayed against the stored value:

```
naive string sent:  2026-09-20T21:40:00
read as UTC, shown in America/Chicago:  9/20/2026, 4:40:00 PM
```

That is the exact value in the row. The gap is the zone offset, which is why it
was exactly five hours and not a rounding error.

## Failure 2 — the blank cells

The Shortcut later switched to emitting a full ISO stamp as the `captureId`. The
fallback regex only recognized the compact form:

```js
/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/
```

`2026-09-21T09:09:12-05:00` fails it at character five — the pattern wants two
digits where the ISO string has `-0`. No match meant no fallback, and since the
Shortcut sends no `capturedAt` key either, the property was simply never written.

Ground truth from Photos confirms the ID itself was correct: `IMG_2658` was
recorded **Monday, Sep 21, 2026 at 09:09**, 4:01 long, and the row's Duration
reads 241 s. Only the date column was lost.

## Fix

Three changes in `Normalize Capture`, one in `Config`.

1. **`toZonedIso()`** — every datetime now leaves the workflow with an explicit
   offset. Already-zoned input is kept as-is (`-0500` is normalized to `-05:00`),
   naive input gets the configured zone's offset, date-only input passes through
   untouched, and unparseable input becomes a 400 rather than a silent wrong date.
2. **`capturedAtFromId()`** — the fallback now reads both captureId shapes, the
   compact `20260920-2140` and a full ISO prefix, and keeps the ISO string's own
   offset when it carries one.
3. **DST is computed, not assumed.** The offset comes from `Intl` at the
   capture's wall-clock instant, so a January capture writes `-06:00` and a July
   one writes `-05:00`. Hardcoding `-05:00` would have re-broken every row from
   November through March.
4. **`captureTimeZone`** in *Config*, default `America/Chicago` — the only place
   the zone is named.

Verified across both live captureId formats, both Central offsets, both DST
boundary times, half-hour zones, and the `Z` / `-0500` / date-only / junk /
`null` input shapes.

## What this does not fix

The two existing blank rows. The fallback deliberately feeds the **create** path
only — `captureId` rides every request, so deriving it into `updateProperties`
would overwrite a hand-edited date on every re-POST. Backfill them either by
hand, or by re-POSTing with an explicit `capturedAt`, which *is* honored on
update:

```json
{ "captureId": "2026-09-21T09:09:12-05:00", "capturedAt": "2026-09-21T09:09:12-05:00" }
```

## Shortcut side — optional now, still worth doing

The workflow no longer needs it, but sending the key explicitly makes the
capture instant independent of the ID format:

* **Key:** `capturedAt`
* **Value:** `Date Created` chip → Custom format `yyyy-MM-dd'T'HH:mm:ssxxx`

`xxx` is what emits `-05:00`. Without it the workflow falls back to
`captureTimeZone`, which is right as long as the iPad and that setting agree —
it will not follow you across a time zone the way the Date chip does.
