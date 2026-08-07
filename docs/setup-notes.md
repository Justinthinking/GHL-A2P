# WF-OFFER-ENGINE-SFR — Setup Notes

The workflow already exists in your n8n instance (created via MCP, **inactive**):
**https://dfn8n.xyz/workflow/xMXAC2ESeeO6eqhn**

`workflows/WF-OFFER-ENGINE-SFR.json` in this repo is the same workflow as an
importable file (regenerate it any time with `node scripts/build-workflow-json.mjs`).

## 1. IDs — already wired in

| Value | Where it came from | Baked into |
|---|---|---|
| Baserow database `204`, table **`764`** (`Underwriting_Worksheet`) | `baserow.dfn8n.xyz/database/204/table/764` | Both Baserow HTTP node URLs |
| GHL location **`fPnzZjzdvxzEGdkhdQ0e`** | XLeads pipeline URL | "GHL: Fetch Pipeline Stages" query param |
| GHL pipeline **`MXHfKwSzSiKSSDfkajSO`** | XLeads pipeline URL | "Resolve Pre-LOI Stage" code node |
| Pre-LOI stage ID | *not needed* | Resolved by name at run time (see below) |

**Why there's no stage ID to paste.** The GHL pipeline URL exposes the pipeline ID but
not individual stage IDs. Instead of hardcoding one, the workflow calls
`GET /opportunities/pipelines?locationId=…`, finds the pipeline, and matches the first
stage whose name matches `/pre[\s_-]*loi/i` — so "Pre-LOI Ready", "Pre LOI", and
"pre_loi" all work. If the stage doesn't exist, the node throws a readable error listing
the stages it did find, rather than silently writing a wrong stage.

## 1b. Still to fill

| Placeholder | Where | What to put there |
|---|---|---|
| Telegram chat ID | Both Telegram nodes (shown as a placeholder field) | Team chat ID for @Jarvis772_bot (ask `@get_id_bot`) |

## 2. Credentials to wire (n8n → each node's credential selector)

| Credential | Type | Nodes | Contents |
|---|---|---|---|
| Baserow Database Token | HTTP Header Auth | Get Worksheet Row, Baserow: Write Audit + Underwritten | Header `Authorization`: `Token <your Baserow database token>` |
| GHL API (LeadConnector) | HTTP Header Auth | All three GHL nodes | Header `Authorization`: `Bearer <GHL Private Integration / API key>` (the `Version: 2021-07-28` header is already on the nodes) |
| Telegram account | Telegram API | Both Telegram nodes | Already auto-wired to your existing @Jarvis772_bot credential |

## 3. Baserow webhook (the trigger) — needs fixing

There is already a webhook named **"GHL pre LOI"** on `Underwriting_Worksheet`, but as
configured it will never fire this workflow. Three things are wrong:

| Setting | Currently | Must be |
|---|---|---|
| URL | `https://baserow.dfn8n.xyz/api/database/rows/table/…` (points back at Baserow's own API) | `https://dfn8n.xyz/webhook/offer-engine-sfr` |
| Method | `GET` | `POST` |
| Events | "Rows are created" only | **"Rows are updated"** |

"Use field name instead of id" can stay off — the workflow only reads `items[0].id`
from the webhook body and then re-fetches the full row itself with
`user_field_names=true`. Turning it on is harmless and makes the call log easier to read.

For a dry run before going live, point the URL at
`https://dfn8n.xyz/webhook-test/offer-engine-sfr` and click "Listen for test event" on
the trigger node in n8n.

Every row edit fires the webhook; the "Status Is Ready?" IF node drops everything
except rows whose `status` is `Ready`, so Draft edits and the engine's own
`Underwritten` writeback never re-trigger a computation (idempotent by design).

## 4. GHL opportunity custom-field keys

"GHL: Update Opportunity Fields" sends `customFields: [{ key, field_value }]` with keys:
`new_mao`, `arvrepairs`, `repairs`, `contract_price`, `uwspread`, `uwratio`,
`uw_reason`, `property_types`, `unit_count`, `unit_rent_monthly`, `hoa_monthly`,
`jv_opportunity_value`.

These custom fields must exist on the **opportunity** object in your location (M0).
If your GHL account rejects `key`-based updates, fetch the field IDs
(`GET /locations/{locationId}/customFields?model=opportunity`) and swap `key` for `id`
in the Underwrite Code node's `ghl_custom_fields` mapping.

Fields with empty values (e.g. `contract_price` not provided, `hoa_monthly` on an SFR)
are omitted from the payload rather than written as null.

## 5. Guardrails built in

- **Code computes the offer.** There is no LLM node anywhere in the workflow.
- ARV/Repairs come only from the human-confirmed Baserow row fetched at run time.
- Missing/zero `arv` or `repairs`, or missing GHL contact/opportunity IDs → ⛔ Telegram
  halt alert, nothing written (no $0 offers).
- `seller_draft` is written to a Baserow review field only — **never auto-sent**.
- GHL/Baserow HTTP nodes retry on failure (GHL: 5 tries / 5 s between — covers 429s;
  Baserow: 3 tries / 2 s). If you later batch contacts elsewhere, cap groups at 200–250.
- Writeback order: GHL fields → GHL note → Baserow audit + `status=Underwritten` →
  GHL stage → Telegram. A re-fire of the same Ready row recomputes identical values
  (deterministic on the row), so retries are safe; once `Underwritten`, re-fires are skipped.

## 6. Go-live checklist (M5 accept)

Everything below is what's left to make the workflow testable end to end.

1. **Baserow table fields.** The table exists (764) with intake fields. Confirm the 10
   engine output fields from `docs/baserow-underwriting-worksheet.md` exist —
   `arv_minus_repairs`, `factor_used`, `new_mao`, `uw_spread`, `uw_ratio`,
   `jv_opportunity_value`, `uw_reason`, `offer_note`, `seller_draft`, `computed_at`.
   Baserow rejects a PATCH naming a field that doesn't exist, so a missing one fails
   the writeback step.
2. **Credentials.** Create the two HTTP Header Auth credentials (section 2) and select
   them on all six HTTP nodes — n8n can't auto-assign those.
3. **Telegram chat ID** on both Telegram nodes.
4. **GHL Pre-LOI stage.** Make sure the wholesale pipeline actually has a stage whose
   name contains "Pre-LOI". If not, add it in XLeads first.
5. **GHL opportunity custom fields** (section 4) must exist on the opportunity object.
6. **Fix the Baserow webhook** per section 3.
7. **Test.** Point the webhook at `/webhook-test/…`, click "Listen for test event",
   set a test row's `arv`, `repairs`, `ghl_contact_id`, `ghl_opportunity_id`, then flip
   `status` to `Ready`. Walk the execution node by node.
8. **Verify:** GHL opportunity fields populated, contact note created, Baserow row shows
   outputs + `Underwritten` + `computed_at`, stage moved to Pre-LOI Ready, Telegram
   summary received.
9. Switch the webhook to the production URL and **activate** the workflow.

The math itself is already covered by `node --test tests/` in this repo (10 fixtures),
so step 7 is testing the plumbing, not the formula.

## Still open (from the brief, deliberately not built)

- `jv_opportunity_value` formula — undefined; pass-through of the human-entered value.
- `confidence` — human single-select until a comp-dispersion rule is supplied.
- M2 Privy prefill writer; Condo/TH, Income, Land engine branches (M6 clones).
