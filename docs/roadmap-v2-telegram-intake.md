# V2 Plan — Full Intake Loop from the Walkthrough Transcript

## Context

The original build brief scoped one workflow: a VA fills a Baserow worksheet by hand,
flips `status` to `Ready`, and the engine computes the offer. That is built and deployed
(`WF-OFFER-ENGINE-SFR`, 15 nodes).

The walkthrough transcript describes the **whole operating loop around** that engine —
how a row gets created in the first place, how the Privy PDF gets in, and how a human
approves before any number reaches GoHighLevel. Roughly: nothing about the math changes;
everything about intake and approval is new.

Transcript decoder (the recording garbles several terms): **"prerefile" / "prere" = Privy**,
**"NAN" = n8n**, **"One-Two-Sale" = the first stage of the wholesale pipeline** (exact
name/ID to confirm — likely "1-2 Sale").

## The loop the transcript describes

1. Seller replies to SMS; the GHL AI conversation bot decides they want an offer and
   adds them to the **wholesale pipeline**, stage **"1-2 Sale"**.
2. Hitting that stage pushes all contact info to Baserow — contact ID, opportunity ID,
   name, address — auto-filling the `Underwriting_Worksheet` columns.
3. Telegram fires: *"New contact added"* with **name, address, contact ID**, and a
   prompt to go pull the Privy document.
4. Human copies the address out of Telegram, pulls the property up in Privy, downloads
   the PDF.
5. Human uploads that PDF **into the @STL_Offer_bot Telegram chat**.
6. n8n receives the document, an **LLM reads the PDF**, and the extracted details are
   written into the same worksheet row.
7. The bot replies with **everything it just added** plus a button: **"Yes, information
   looks good."**
8. Pressing it **computes the offer** and writes to GoHighLevel.
9. GHL moves the opportunity to **"Pre-LOI Ready"**.
10. That stage drafts an **SMS to the seller**; a human accepts the send in GHL after
    eyeballing the numbers.

## Gap analysis

| Transcript step | Status today |
|---|---|
| 1–2 GHL stage → Baserow row | ❌ not built — rows are created by hand |
| 3 Telegram "new contact, pull Privy" | ❌ not built |
| 4 Human pulls Privy PDF | manual, stays manual |
| 5–6 Telegram PDF upload → LLM extract → Baserow | ❌ not built (this is the brief's M2, deferred) |
| 7 Telegram confirmation card + approve button | ❌ not built |
| 8 Compute offer + GHL writeback | ✅ **built** — `WF-OFFER-ENGINE-SFR` |
| 9 Stage → Pre-LOI Ready | ✅ **built** (resolves stage by name) |
| 10 SMS draft for human approval | ⚠️ partial — `seller_draft` text is generated and stored in Baserow, but nothing creates a GHL SMS draft |

So the engine and writeback are done. What's missing is the intake half and the approval
gate.

## Two guardrail tensions worth deciding deliberately

**1. The LLM must not become the source of ARV and Repairs.**
The brief's golden rule is *"LLMs extract and draft; code computes,"* and it is explicit
that ARV and Repairs are human-confirmed because they are the numbers that must not be
wrong. The transcript has the LLM populate the worksheet and the human approve with one
tap. Those are reconcilable — the tap *is* the confirmation — but only if the card makes
the two numbers impossible to skim past. If the button just says "looks good" under a
wall of extracted fields, in practice ARV becomes LLM-authored.

Recommendation: the Telegram card leads with ARV and Repairs in large, isolated lines,
and offers **three** buttons — ✅ Looks good, ✏️ Edit ARV/Repairs, ❌ Reject. Never a
bare confirm. The engine keeps refusing to run on missing/zero values regardless.

**2. The SMS must stay a draft.**
The brief says never auto-send SMS to the seller. The transcript agrees ("the last thing
we have to do is just accept the message to send it"). Implement step 10 as a GHL draft
or a task/notification for a human — never an outbound send from n8n.

## Proposed architecture

Four pieces. The existing engine gets refactored so both the current Baserow path and
the new Telegram-approval path drive the same math.

```
GHL "1-2 Sale" stage
      │  (GHL automation → webhook)
      ▼
WF-INTAKE-GHL-TO-BASEROW ──► Baserow Draft row ──► Telegram "pull Privy for <address>"
                                                          │
                                        human uploads Privy PDF to @STL_Offer_bot
                                                          ▼
                                          WF-PRIVY-INGEST (LLM extract → Baserow)
                                                          │
                                          Telegram card + [✅ ✏️ ❌] buttons
                                                          ▼
                                          WF-APPROVAL-EXECUTOR (callback_query)
                                                          │  sets status = Ready
                                                          ▼
                                     WF-OFFER-ENGINE-SFR (existing, unchanged math)
                                                          │
                                     GHL fields + note + stage → Telegram summary
                                                          ▼
                                          WF-SMS-DRAFT (Pre-LOI Ready → GHL draft)
```

### A. `WF-INTAKE-GHL-TO-BASEROW` (new)

- **Trigger:** n8n Webhook. In GHL, build an automation on the wholesale pipeline:
  trigger *Opportunity Stage Changed → stage "1-2 Sale"*, action *Webhook* POSTing the
  contact and opportunity payload.
- Normalize the GHL payload → create a Baserow row in table 764 with `ghl_contact_id`,
  `ghl_opportunity_id`, `property_address`, name into `decision_makers`, phone/email if
  columns are added, `property_type` defaulted to `SFR`, `status = Draft`.
- **Idempotency:** query Baserow for an existing row with the same `ghl_contact_id`
  first; update rather than insert. GHL automations can fire twice on a stage bounce, and
  duplicate worksheets would be worse than a missed one.
- Then → Telegram: *"🆕 New contact added"* with name, **address**, contact ID, and
  *"Please pull the Privy document for this address and upload the PDF here."*
  Address on its own line so it is one-tap copyable on mobile.
- Stash `baserow_row_id` + `ghl_contact_id` in the message so the next step can correlate.

### B. `WF-PRIVY-INGEST` (new — this is the brief's deferred M2)

- **Trigger:** Telegram Trigger on document uploads to @STL_Offer_bot.
- **Correlate the upload to a row.** The hard part: a bare PDF has no row ID attached.
  Options, best first:
  1. Have the human **reply** to the bot's "New contact added" message when uploading —
     Telegram includes `reply_to_message.message_id`, which maps to a row via a small
     Baserow lookup table (`telegram_message_id` → `row_id`).
  2. Otherwise fall back to the most recent `Draft` row awaiting a Privy doc.
  3. If neither resolves, reply asking which address this belongs to. Never guess.
- Download the file, extract text (Extract from PDF node), then an LLM node returning
  **strict JSON** via a structured output parser: `beds`, `baths`, `sqft`, `lot_sqft`,
  `year_built`, `assessor_market_improved`, `arv_suggested`, `repair_band_low`,
  `repair_band_high`, plus a `comps` summary string.
- **The LLM never emits a final ARV or repairs figure into the engine's fields.** It
  writes `arv` and `repairs` as *suggestions* the human confirms in step C. Keep the
  suggestion in its own column (`arv_suggested`) so the audit trail shows what was
  proposed versus what was confirmed.
- Write extracted values into the row; keep `status = Draft`.
- Reply with the confirmation card (below).

### C. `WF-APPROVAL-EXECUTOR` (new)

- **Trigger:** Telegram Trigger on `callback_query`.
- Card format:

  ```
  📄 Privy read for 123 Main St
  ─────────────────────────
  ARV        $180,000
  Repairs     $30,000
  ─────────────────────────
  3bd / 2ba · 1,450 sqft · built 1978
  Assessor (ref only): $121,000
  Comps: 3 sold within 0.4 mi, $172k–$191k

  Confirm these numbers to compute the offer.
  [✅ Looks good]  [✏️ Edit ARV/Repairs]  [❌ Reject]
  ```
- ✅ → set `status = Ready` on the row. That single write fires the **existing**
  `WF-OFFER-ENGINE-SFR` webhook, so the math path stays exactly one implementation.
- ✏️ → bot asks for `ARV, Repairs` as a reply (e.g. `185000, 32000`), writes them, then
  re-renders the card.
- ❌ → mark the row rejected and stop.
- Answer the callback query so Telegram clears the button spinner; edit the original
  message to record who approved and when.

> Two existing workflows — **"🔥 Hot Leads — Stage Proposal (Claude → Telegram Approval)"**
> and **"✅ Hot Leads — Approval Executor (Telegram → Baserow → GHL)"** — already implement
> this callback-button pattern against Baserow and GHL. Copy their node wiring rather than
> reinventing it. They are not readable over MCP right now (access disabled), so this needs
> either enabling MCP on them or opening them in the n8n UI.

### D. `WF-SMS-DRAFT` (new, small)

- **Trigger:** either chained off the engine's final node, or a GHL automation on entering
  "Pre-LOI Ready".
- Create a **draft** SMS on the contact using the existing `seller_draft` text already
  computed by the engine (a book-the-call nudge with no dollar figure in it).
- Notify Telegram that a draft is waiting for a human to approve the send in GHL.
- **No outbound send from n8n under any circumstance.**

### E. Refactor to `WF-OFFER-ENGINE-SFR` (small)

Two options:
- **Minimal (recommended):** leave it alone. The approval executor sets `status = Ready`,
  the Baserow webhook fires the engine, done. No change to tested code.
- **Cleaner later:** convert the engine to an Execute Workflow sub-workflow so callers
  invoke it directly instead of round-tripping through a Baserow write. Defer until the
  loop is proven end to end.

Either way the `src/underwrite.mjs` math and its 10 fixtures stay authoritative.

## Baserow schema additions (table 764)

| Column | Type | Why |
|---|---|---|
| `telegram_message_id` | Number | Correlates a Privy upload back to its row |
| `arv_suggested` | Number | LLM proposal, kept separate from confirmed `arv` |
| `repair_band_low` / `repair_band_high` | Number | LLM repair estimate range |
| `comps_summary` | Long text | What the LLM based ARV on — audit trail |
| `privy_extracted_at` | Text/Date | When the PDF was parsed |
| `approved_by` / `approved_at` | Text | Who tapped ✅ |
| `contact_phone`, `contact_email` | Text | Carried from GHL for the SMS draft |
| `status` | extend select | Add `Awaiting Privy`, `Awaiting Approval`, `Rejected` |

The status vocabulary matters: the engine currently fires only on exactly `Ready`, and
the new intermediate states must not collide with it.

## Build sequence

Each step independently testable, in dependency order.

| # | Deliverable | Done when |
|---|---|---|
| V2-0 | Baserow schema additions + status options | Columns exist; engine still passes its dry run |
| V2-1 | `WF-INTAKE-GHL-TO-BASEROW` + GHL automation on "1-2 Sale" | Moving a test contact to that stage creates exactly one Draft row |
| V2-2 | Telegram "new contact, pull Privy" message | Message arrives with copyable address; row records its `message_id` |
| V2-3 | `WF-PRIVY-INGEST` — upload → text extraction → row update | Replying to the bot with a real Privy PDF fills the spec columns |
| V2-4 | LLM extraction with structured output + `arv_suggested` | Three different Privy PDFs parse without hand-fixing |
| V2-5 | Confirmation card + 3 buttons | Card renders; ✏️ round-trip updates ARV/Repairs |
| V2-6 | `WF-APPROVAL-EXECUTOR` → sets `Ready` | ✅ triggers the existing engine; offer lands in GHL |
| V2-7 | `WF-SMS-DRAFT` | Draft appears in GHL; nothing sends automatically |
| V2-8 | Hardening: idempotency, unmatched-upload path, LLM failure fallback | Duplicate stage fire creates no second row; junk PDF asks a human |

V2-1 through V2-3 are worth building before touching the LLM — they are the part that
saves the most manual typing and carries the least risk.

## Open decisions

1. **Exact "1-2 Sale" stage name and ID** in pipeline `MXHfKwSzSiKSSDfkajSO`.
2. **Which LLM for PDF extraction.** The account already runs both a Claude-backed
   workflow and a local Ollama one. Privy PDFs contain owner names and addresses; local
   Ollama keeps that on the Mac Mini, a hosted model is more reliable at structured
   extraction. Recommend Claude for accuracy, with the caveat noted.
3. **Does the LLM propose ARV/Repairs at all,** or only specs and comps with the human
   always typing the two numbers? The plan above assumes propose-then-confirm.
4. **Where the Privy upload correlates** — reply-to-message (recommended) versus
   most-recent-draft.
5. **Whether GHL can create a true SMS draft** via API in this account, or whether step 10
   should instead be a GHL task assigned to a human.

## What does not change

The math, the factor table, `src/underwrite.mjs`, its 10 fixtures, the halt guard, and
the rule that no LLM sits in the compute path. Everything above feeds *inputs* to that
engine and gates them behind a human tap.
