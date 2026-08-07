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

## 1b. Credentials — what's wired and what isn't

| Credential | Type | Nodes | Status |
|---|---|---|---|
| Baserow (host `https://baserow.dfn8n.xyz` + database token) | Baserow Token API | Get Worksheet Row, Baserow: Write Audit + Underwritten | ✅ auto-assigned — **verify it picked the right one**, see below |
| GHL bearer (`Authorization: Bearer <key>`) | HTTP Header Auth | The four `GHL:` HTTP nodes | ⚠️ **must be selected by hand** |
| Telegram bot | Telegram API | Both Telegram nodes | ✅ auto-assigned — **verify it's @STL_Offer_bot** |

Chat ID `6707585706` is baked into both Telegram nodes.

**Two things to check by eye when you open the workflow:**

1. n8n auto-assigned the Baserow credential named **"SQL Baserow"** because it was the
   first `baserowTokenApi` credential in the account. If the credential you created for
   this build is a different one, switch both Baserow nodes to it — a wrong host or a
   token scoped to another database fails at run time.
2. The Telegram nodes got the credential named **"Telegram account"**. Confirm that is
   the @STL_Offer_bot token and not an older bot; the chat ID only works with the bot
   that the chat was started with.

n8n's API cannot attach credentials to generic HTTP Request nodes, so the four GHL
nodes are the one manual step: open each, set **Authentication → Generic Credential
Type → Header Auth**, and pick your GHL bearer credential.

## 2. Why the Baserow steps use the native node

The two Baserow steps use the **Baserow node** rather than HTTP Request, because the
Baserow Token API credential type only binds to that node. The update step is preceded
by a small "Build Baserow Audit Row" Code node that emits exactly the audit columns, so
the Baserow node's auto-map matches keys to columns by name. Do not add keys to that
Code node's output unless the matching column exists in table 764 — Baserow rejects the
whole update if one name is unknown.

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

## 6. First test — including where the Privy doc fits

**The Privy PDF is not uploaded to this workflow.** M2 (the Privy prefill writer) is
not built. In the current design a human reads the Privy PDF and types the numbers into
the worksheet — that is the human-in-the-loop step the brief asks for. So "uploading the
first Privy doc" means: open the PDF, read it, and fill a Baserow row from it. The PDF
itself only gets stored as a reference link in `privy_pdf_url`.

### Before the first run

1. **Baserow output columns.** Table 764 has the intake fields. Confirm the 11 engine
   output columns from `docs/baserow-underwriting-worksheet.md` exist:
   `arv_minus_repairs`, `factor_used`, `new_mao`, `uw_spread`, `uw_ratio`,
   `jv_opportunity_value`, `uw_reason`, `offer_note`, `seller_draft`, `computed_at`,
   and the `status` select with an `Underwritten` option. A missing column fails the
   whole writeback.
2. **GHL Bearer credential** on the four `GHL:` HTTP nodes (section 1b).
3. **Verify the auto-assigned Baserow and Telegram credentials** are the right ones.
4. **Pre-LOI stage** exists in pipeline `MXHfKwSzSiKSSDfkajSO`.
5. **GHL opportunity custom fields** (section 4) exist.
6. **Send `/start` to @STL_Offer_bot** from the target chat, or Telegram will reject
   the send with "chat not found".

### Dry run — no Baserow webhook needed

You don't have to fix the webhook to test the engine. Pin fake input instead:

1. Open the workflow, click the **Underwrite** node.
2. On its input panel choose **Edit Output** on "Get Worksheet Row" (or use "Execute
   step" with pinned data) and paste a row shaped like this, using real GHL IDs from a
   test contact:

```json
{
  "id": 1,
  "ghl_contact_id": "<real contact id>",
  "ghl_opportunity_id": "<real opportunity id>",
  "property_address": "123 Test St, Baton Rouge LA",
  "property_type": { "value": "SFR" },
  "arv": 180000,
  "repairs": 30000,
  "contract_price": 95000,
  "confidence": { "value": "High" },
  "status": { "value": "Ready" },
  "decision_makers": "Test Seller"
}
```

3. **Execute Workflow**. Expected: `new_mao` = **107000**, `uw_spread` = **12000**,
   `uw_ratio` = **0.5278**. Those exact numbers are asserted in `tests/underwrite.test.mjs`,
   so if the node shows something else, the Code node drifted from the repo.
4. Walk each node after it and confirm the GHL calls return 2xx.

### Live run with a real Privy doc

1. Open the Privy PDF for one SFR. Read off: address, beds/baths/sqft/lot/year,
   the assessor value, and the comps you'll base ARV on.
2. In Baserow table 764, create a row: paste `ghl_contact_id` and
   `ghl_opportunity_id` from that contact in GHL, `property_address`,
   `property_type` = `SFR`, the specs, `assessor_market_improved` (reference only —
   **not** ARV), and `privy_pdf_url` / `landglide_url` as links.
3. Enter **`arv`** and **`repairs`** — your judgement from the comps and condition.
   Nothing else drives the offer.
4. Optionally `contract_price` (enables spread/ratio), CTMAPO fields, `transcript_text`,
   `confidence`.
5. Leave `status` on `Draft` while you work.
6. Fix the Baserow webhook per section 3, pointing at the **test** URL first.
7. Click "Listen for test event" in n8n, then flip `status` to **`Ready`**.
8. **Verify:** GHL opportunity custom fields populated, contact note created, the
   Baserow row now shows the outputs + `Underwritten` + `computed_at`, opportunity moved
   to Pre-LOI Ready, Telegram summary in chat 6707585706.
9. Switch the webhook to the production URL and **activate** the workflow.

### Deliberate failure test (worth doing once)

Blank the `repairs` on a Draft row and set it to `Ready`. Expect: no writes anywhere,
and a ⛔ halt message in Telegram naming the row. That confirms the guard works before
you trust it with live sellers.

The math is already covered by `node --test tests/` (10 fixtures), so these runs are
testing plumbing and permissions, not the formula.

## Still open (from the brief, deliberately not built)

- `jv_opportunity_value` formula — undefined; pass-through of the human-entered value.
- `confidence` — human single-select until a comp-dispersion rule is supplied.
- M2 Privy prefill writer; Condo/TH, Income, Land engine branches (M6 clones).
