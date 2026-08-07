# WF-OFFER-ENGINE-SFR — Setup Notes

The workflow already exists in your n8n instance (created via MCP, **inactive**):
**https://dfn8n.xyz/workflow/xMXAC2ESeeO6eqhn**

`workflows/WF-OFFER-ENGINE-SFR.json` in this repo is the same workflow as an
importable file (regenerate it any time with `node scripts/build-workflow-json.mjs`).

## 1. Placeholders to fill (every `REPLACE_*` marker)

| Placeholder | Where | What to put there |
|---|---|---|
| `REPLACE_BASEROW_TABLE_ID` | "Get Worksheet Row" + "Baserow: Write Audit + Underwritten" URLs | Numeric table ID of `Underwriting_Worksheet` (visible in the Baserow table URL) |
| `REPLACE_GHL_PIPELINE_ID` | "GHL: Stage → Pre-LOI Ready" body | Pipeline ID of the hot-seller pipeline (GHL API: `GET /opportunities/pipelines`) |
| `REPLACE_GHL_STAGE_PRELOI_READY_ID` | same node | Stage ID of **Pre-LOI Ready** in that pipeline |
| Telegram chat ID | Both Telegram nodes (marked placeholder) | Team chat ID for @Jarvis772_bot (ask `@get_id_bot`) |

## 2. Credentials to wire (n8n → each node's credential selector)

| Credential | Type | Nodes | Contents |
|---|---|---|---|
| Baserow Database Token | HTTP Header Auth | Get Worksheet Row, Baserow: Write Audit + Underwritten | Header `Authorization`: `Token <your Baserow database token>` |
| GHL API (LeadConnector) | HTTP Header Auth | All three GHL nodes | Header `Authorization`: `Bearer <GHL Private Integration / API key>` (the `Version: 2021-07-28` header is already on the nodes) |
| Telegram account | Telegram API | Both Telegram nodes | Already auto-wired to your existing @Jarvis772_bot credential |

## 3. Baserow webhook (the trigger)

In Baserow → `Underwriting_Worksheet` table → three-dot menu → **Webhooks** → create:

- URL: `https://dfn8n.xyz/webhook/offer-engine-sfr` (test runs: `https://dfn8n.xyz/webhook-test/offer-engine-sfr`)
- Method: POST
- Events: **rows.updated** only
- **"Use field names instead of IDs": ON** (the workflow reads `body.items[0].id` and re-fetches the row itself, but keep names on for debuggability)

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

1. Fill the placeholders and wire credentials (above), then **Save**.
2. Unit math is already covered: `node --test tests/` in this repo (10 passing fixtures).
3. Click "Listen for test event" on the webhook node, edit a test row's status to
   `Ready`, and walk the execution node by node.
4. Verify: GHL opportunity fields populated, contact note created, Baserow row shows
   outputs + `Underwritten` + `computed_at`, stage moved to Pre-LOI Ready, Telegram
   summary received.
5. Activate the workflow. Run one live SFR end-to-end.

## Still open (from the brief, deliberately not built)

- `jv_opportunity_value` formula — undefined; pass-through of the human-entered value.
- `confidence` — human single-select until a comp-dispersion rule is supplied.
- M2 Privy prefill writer; Condo/TH, Income, Land engine branches (M6 clones).
