# GHL-A2P

A 2P website

## OR-Deal Offer Engine (WF-OFFER-ENGINE-SFR)

Deterministic wholesale offer engine for the Louisiana operation, built from the
OR-Deal build brief. A VA confirms ARV/Repairs in a Baserow `Underwriting_Worksheet`
form; flipping the row's status to **Ready** triggers an n8n workflow that computes
NEW MAO in code (no LLM in the math path), writes back to GoHighLevel
(opportunity fields, contact note, stage → Pre-LOI Ready) and Baserow
(audit fields, status → Underwritten), and posts a Telegram team summary.

**Formula:** `NEW MAO = round((ARV − Repairs) × factor − $10,000)`, factor from an
ARV-band lookup table.

| Path | What it is |
|---|---|
| `src/underwrite.mjs` | The underwriting math — single source of truth, mirrored into the n8n Code node |
| `tests/underwrite.test.mjs` | Fixtures per brief M3 (`node --test tests/`) |
| `workflows/WF-OFFER-ENGINE-SFR.json` | Importable n8n workflow |
| `workflows/WF-OFFER-ENGINE-SFR.sdk.js` | n8n Workflow SDK source used to create it |
| `scripts/build-workflow-json.mjs` | Regenerates the JSON from `src/underwrite.mjs` |
| `docs/baserow-underwriting-worksheet.md` | Baserow create-table + form checklist (M0/M1) |
| `docs/setup-notes.md` | Placeholders, credentials, webhook setup, go-live checklist |

Live (inactive until credentials are wired): https://dfn8n.xyz/workflow/xMXAC2ESeeO6eqhn

Scope: SFR only. Condo/TH, Income, and Land branches plus the Privy prefill writer
(M2) are deliberately not built yet.
