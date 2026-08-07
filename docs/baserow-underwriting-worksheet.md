# Baserow `Underwriting_Worksheet` — Create-Table Checklist (M0/M1)

Create this table in the `Hot_Leads` database at `baserow.dfn8n.xyz`, then build the
form view described at the bottom. Field names must match **exactly** — the workflow
reads and writes rows with `user_field_names=true`, so any rename breaks it.

## Intake fields (human / prefill)

| # | Field name | Type | Required | Notes |
|---|---|---|---|---|
| 1 | `ghl_contact_id` | Text | ✅ | Hidden on the form, prefilled from GHL. **Join key — nothing works without it.** |
| 2 | `ghl_opportunity_id` | Text | ✅ | Hidden, prefilled. Writeback target for opportunity fields. |
| 3 | `property_address` | Text | | Prefill from Privy |
| 4 | `property_type` | Single select: `SFR` \| `Condo/TH` \| `Income` \| `Land` | ✅ | Routes engine logic; only SFR is built so far |
| 5 | `arv` | Number | ✅ | **Human-confirmed** (any prefill is a suggestion only) |
| 6 | `repairs` | Number | ✅ | **Human-confirmed** (prefill = band midpoint) |
| 7 | `contract_price` | Number | | Optional target/floor from the call |
| 8 | `beds` | Number | | Prefill from Privy |
| 9 | `baths` | Number | | Prefill from Privy |
| 10 | `sqft` | Number | | Prefill from Privy |
| 11 | `lot_sqft` | Number | | Prefill from Privy |
| 12 | `year_built` | Number | | Prefill from Privy |
| 13 | `unit_count` | Number | | Income type only |
| 14 | `unit_rent_monthly` | Number | | Income type only |
| 15 | `hoa_monthly` | Number | | Condo/TH type only |
| 16 | `assessor_market_improved` | Number | | Prefill from Privy Tax & Assessment — **REFERENCE ONLY, not ARV** |
| 17 | `transcript_text` | Long text | | VA pastes the Obsidian voicenote transcript |
| 18 | `condition_notes` | Long text | | CTMAPO |
| 19 | `timeline` | Text | | CTMAPO |
| 20 | `motivation` | Text | | CTMAPO |
| 21 | `asking_price` | Number | | CTMAPO |
| 22 | `occupancy` | Text | | CTMAPO |
| 23 | `obligations_liens` | Text | | CTMAPO |
| 24 | `decision_makers` | Text | | CTMAPO — first word is used as the greeting name in `seller_draft` |
| 25 | `floor_signal` | Text | | CTMAPO |
| 26 | `landglide_url` | Text | | Reference string only — never fetched |
| 27 | `privy_pdf_url` | Text | | Reference string only |
| 28 | `status` | Single select: `Draft` \| `Ready` \| `Underwritten` | ✅ | Default `Draft`. **`Ready` is the trigger flag.** |
| 29 | `confidence` | Single select (e.g. `Low` \| `Medium` \| `High`) | | Human-entered until a comp-dispersion rule exists |

## Output fields (engine writes back — audit trail)

| # | Field name | Type | Written by engine |
|---|---|---|---|
| 30 | `arv_minus_repairs` | Number | net = ARV − Repairs |
| 31 | `factor_used` | Number (4 decimals) | Factor from ARV band lookup |
| 32 | `new_mao` | Number | round(net × factor − $10,000) |
| 33 | `uw_spread` | Number | NEW MAO − contract_price (blank when no contract_price) |
| 34 | `uw_ratio` | Number (4 decimals) | contract_price / ARV, stored as decimal (×100 for display) |
| 35 | `jv_opportunity_value` | Number | Pass-through of human value; blank stays blank |
| 36 | `uw_reason` | Long text | Auto-generated audit string |
| 37 | `offer_note` | Long text | Internal note text (also posted to GHL contact) |
| 38 | `seller_draft` | Long text | Book-the-call nudge — **for VA review only, never auto-sent** |
| 39 | `computed_at` | Text (ISO timestamp) or Date w/ time | Engine run timestamp |

## Form view (M1)

- Include: `property_type`, `arv`, `repairs`, `contract_price`, all CTMAPO fields (18–25),
  `transcript_text`, `confidence`.
- `ghl_contact_id` + `ghl_opportunity_id`: hidden, prefilled via form URL query params
  (`?ghl_contact_id=...`) from the GHL automation.
- `arv`, `repairs`, `property_type`: required.
- `status` is not on the form; it defaults to `Draft`. The VA flips it to `Ready` in the
  grid view when the worksheet is confirmed — that flip fires the engine.

**Accept test (M1):** manual form submit creates a row carrying the contact ID.
