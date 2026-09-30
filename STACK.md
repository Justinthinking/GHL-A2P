# RROS Stack Plan: Revenue Recovery for East Texas Contractors

Target market: HVAC and plumbing contractors with 2–5 trucks first, then roofers, in the Tyler/Longview corridor. Beaumont comes later.
Offer: database reactivation (re-contacting old, unclosed estimates), sold as an outcome.
Rules:
1. $0 for tools until client #1 pays.
2. **Nothing gets texted until each contact's consent is documented.** Email and manual calls come first; SMS is added only where consent is clear.
3. SMS runs through Twilio. Each client's A2P brand is registered in the client's business name.

> Revision 2 adds a compliance layer, switches to Twilio, uses Cal.com for booking, adds backups, and adds a risk register. See Section 9 for the full change log.

---

## 1. Stack at a Glance

| Layer | Tool | Version / Plan | Cost | Status |
|---|---|---|---|---|
| Owner lookup (primary) | Texas Comptroller, TDLR and TSBPE public lookups | Web portals | $0 | Ready to use |
| Owner lookup (fallback) | Google Maps listing, business website "About" page, LinkedIn | Manual | $0 | Ready to use |
| Targeting and enrichment | Clay.com | Free plan (limited credits and rows per table) | $0 | To set up |
| Database / CRM / commissions | Notion (RROS workspace) | Free / current plan | $0 | Connected |
| Compliance data (opt-outs, consent log) | PostgreSQL, mirrored to Notion | 16 | $0 | Available |
| Automation engine | n8n (self-hosted) | Latest stable, pinned at deploy | $0 | Connected, needs authorization |
| Queue / cache (optional) | Redis | 7 | $0 | Available |
| Containers | Docker + Docker Compose | 29.x | $0 | Available |
| Scripting runtimes | Node.js / Python | 22 LTS / 3.11 | $0 | Available |
| Email (channel #1) | Gmail | Google Workspace / free | $0 | Connected |
| Booking | **Cal.com** (webhooks on free plan) | Free plan | $0 | To set up |
| Scheduling | Google Calendar | Free | $0 | Connected |
| Code and templates | GitHub (`ghl-a2p` repo) | Free | $0 | Connected |
| Compliance websites | GitHub Pages or Cloudflare Pages | Free | $0 | To build |
| Always-on hosting (primary) | Oracle Cloud Always Free (ARM) | Free tier | $0 | To set up |
| Always-on hosting (fallback) | Small paid VPS or a home machine | Only if the primary fails | $0–6/mo | Backup plan |
| SMS delivery (channel #2) | **Twilio** (GHL only if the client already has it) | Pay-as-you-go | Client pays (you float the first ~$100) | After client #1 |
| A2P 10DLC registration | Twilio, in the client's brand | Per client | Client pays | Starts at onboarding, live around weeks 2–3 |
| Tracking numbers | One Twilio number per client | Pay-as-you-go | Client pays | After client #1 |
| Service agreement | One-page contract, reviewed by a lawyer | One-time | ~$0–500 | Before client #1 |
| AI assistant / builder | Claude Code | Current | Existing plan | Active |

---

## 2. Connections Map

```
                    ┌──────────────────────┐
  Public records ──►│                      │◄──── Cal.com (booking webhook)
  Clay (CSV) ──────►│   n8n (automation)   │◄──── Twilio (inbound SMS + call logs)
                    │                      │
                    └──┬─────┬──────┬───┬──┘
                       │     │      │   │
                       ▼     ▼      ▼   ▼
                   Notion  Gmail  Cal. Postgres
                    (CRM) (email)      (opt-outs, consent log, DNC results)
                                         │
                   ┌─────────────────────┘
                   ▼
         COMPLIANCE GATE (consent? not opted out? not on DNC? within allowed hours?)
                   │ pass
                   ▼
         Twilio SMS (client brand, A2P registered, tracking number)

  GitHub (ghl-a2p) ──► Pages host ──► compliance site per client
  n8n + Postgres ──► nightly backup ──► off-server storage
```

| From | To | Method | Purpose |
|---|---|---|---|
| Public records | Notion | Manual entry or n8n import | Owner names for target list |
| Clay | Notion | CSV export → n8n import | Enriched target list |
| Notion | n8n | Native Notion node (limit: ~3 requests/sec) | Read/write targets, clients, claims |
| n8n | Postgres | Native node | Opt-outs, consent log, DNC results, message log |
| n8n | Gmail | Native Gmail node | Email reactivation, daily digest |
| n8n | Google Calendar | Native node | Door-knock follow-up reminders |
| Cal.com | n8n | Webhook | Booked re-estimate → pipeline update |
| n8n | Twilio | Native node | Send SMS, but only after the compliance gate passes |
| Twilio | n8n | Webhook | Inbound replies, STOP/HELP, delivery and call logs |
| GitHub | Pages host | Auto-deploy on push | Client A2P compliance websites |
| n8n + Postgres | Off-server storage | Scheduled export | Nightly backup |
| Claude Code | GitHub, Notion, Gmail, Calendar, n8n | Connectors | Build, update and operate the stack |

---

## 3. Phase 1: Targeting (Door-Knock Reconnaissance)

**Goal:** a printed route sheet with the owner's name, trade, main service and estimated ticket size.

1. **Pick the trade:** start with HVAC and plumbing, since both have state license lookups. Add roofers second. Roofing has no state license in Texas and needs more manual work.
2. **Source the businesses:** Clay Google Maps search by trade and zip code (75701, 75703, 75601, 75604). Use one Clay table per trade to stay under the row limit.
3. **Filter:** 5–15 employees (a stand-in for 2–5 trucks). Flag businesses with 50+ Google reviews as A-tier.
4. **Find owner names, in this order:**
   1. TDLR (HVAC) / TSBPE (plumbing) license holder
   2. Texas Comptroller franchise-tax search (LLCs and corporations only)
   3. Manual: Google Maps listing, the business website's About page, LinkedIn (catches sole proprietors)
   4. Clay waterfall (Apollo → Prospeo → Hunter): **top 50–100 rows only**, and only where 1–3 found nothing
5. **Claygent (Clay's AI web scraper):** main high-ticket service plus estimated average ticket, for A-tier rows only.
6. **Export:** CSV → n8n → Notion `Targets` database → printed route sheet.

---

## 4. Compliance Layer (Required Before Any SMS)

> Not legal advice. A lawyer reviews the message sequence and the service agreement before the first campaign.

**Consent comes first**
- Having an old estimate on file is **not** consent to receive marketing texts. A2P registration doesn't create consent, and an opt-in form on the website doesn't cover past contacts.
- Each contact gets a **consent status**: `Written consent` / `Existing customer, contacted before` / `Unknown`.
- `Unknown` contacts get **email only**, or a manual call from the owner. No automated SMS.
- Keep records of where consent came from (form, date, wording) in the Postgres consent log.

**Rules the gate enforces on every message**
| Rule | Where it runs |
|---|---|
| Contact's consent status allows SMS | Workflow #3 compliance gate |
| Contact isn't on the internal opt-out list | Workflow #3 compliance gate |
| Contact checked against the National Do Not Call registry | Workflow #3 compliance gate, before each campaign |
| Sent only during allowed hours in the contact's time zone (the federal rule is 8am–9pm; Texas law may be stricter, including Sunday hours, so the lawyer confirms) | Workflow #3 compliance gate |
| First message names the business and includes "Reply STOP to opt out" | Message templates |
| STOP / HELP handled automatically and immediately | Workflow #4 |

**A2P timeline:** registration takes weeks, not a day. Plan email and manual reactivation for weeks 1–2 while A2P is approved, and start SMS in week 2–3.

---

## 5. Phase 2: Fulfillment (Database Reactivation)

**Goal:** recover revenue from each client's old, unclosed estimates and prove it in a pipeline.

1. **Week 0 (contract signed):** service agreement signed → Twilio account set up (you create it for the client, the brand is theirs) → A2P brand and campaign submitted.
2. **Compliance site:** generate from the `ghl-a2p` template (privacy policy, SMS terms, opt-in form). A2P reviewers check it.
3. **List prep:** client exports their old estimates → tag each contact's consent status → check against DNC → segment by service type and recency → tag (e.g. `Graveyard_Fall26`).
4. **Weeks 1–2 (email first):**
   - Email reactivation to the whole list, with a Cal.com booking link
   - The owner calls the hottest `Unknown`-consent contacts by hand
5. **Week 2–3 onward (SMS added once A2P is approved):**
   - Day 0: SMS, only to contacts that pass the compliance gate
   - Day 1–2: wait
   - Day 2: follow-up email to anyone who didn't reply
6. **Reply handling:** n8n tags each reply (positive / thinking / not interested / STOP) → STOP goes to the opt-out list immediately → positive replies alert the owner → Notion is updated.
7. **Pipeline stages:** Reactivation Sent → Responded (Positive) → Re-Estimate Booked → Job Won.

---

## 6. Phase 3: Tracking and Getting Paid

| Store | Table | Key Fields |
|---|---|---|
| Notion | `Targets` | Business, Address/Zip, Phone, Owner, Owner Source, Trade, Main Service, Est. Ticket, Tier, Door-Knock Status, Next Follow-Up |
| Notion | `Clients` | Name, Trade, Avg Ticket, Fee Model, Campaign Start, A2P Status, Agreement Signed, Tracking Number, Total Recovered |
| Notion | `Recovery Claims` | Client (relation), Contact, Job Type, Job Value, Fee Owed (formula), Evidence (booking/SMS/call log), Status (Pending / Confirmed / Paid), Date |
| Postgres | `consent_log` | Contact, Client, Status, Source, Date captured |
| Postgres | `opt_outs` | Phone/email, Client, Date, Channel |
| Postgres | `message_log` | Contact, Channel, Template, Sent at, Delivery status, Reply |

**Proof that a job came from the campaign (backed by evidence)**
- One Twilio tracking number per client, with SMS and call logs
- A unique Cal.com booking link per campaign
- A contact counts as recovered only if they appear in the `message_log` and then book or become a Job Won
- The service agreement gives you the right to check the client's job records against your campaign list

**Fee model: setup fee + percentage (hybrid)**
- A small setup fee covers A2P registration, list prep and the SMS costs you float
- Plus a percentage of recovered job value, invoiced monthly from the Confirmed claims in Notion
- Fallback: $2,500 flat for clients who don't want revenue-share tracking

**The one-page service agreement covers:** scope, fees, how recovered jobs are attributed, your right to check records, who is responsible for TCPA compliance (the client supplies consent records), how contact data is handled, and indemnification (who pays if something goes wrong legally).

---

## 7. n8n Workflows to Build

| # | Workflow | Trigger | Output |
|---|---|---|---|
| 1 | Target import | Manual (CSV upload) | Rows in Notion `Targets` |
| 2 | Daily follow-up digest | Schedule, 7 AM | Gmail summary + Calendar reminders |
| 3 | Reactivation sequence **+ compliance gate** | Campaign tag applied | Checks consent, opt-outs, DNC and hours → SMS, or email only → wait → follow-up email → `message_log` |
| 4 | Reply router + **STOP/HELP handler** | Twilio inbound webhook | STOP → `opt_outs` immediately; HELP → auto-reply; positive → owner alert + Notion stage update |
| 5 | Booking capture | Cal.com webhook | Notion stage → Re-Estimate Booked |
| 6 | Recovery claim | Job-won form/webhook | Row in `Recovery Claims` with evidence link |
| 7 | Monthly invoice | Schedule, 1st of month | Confirmed-claims summary via Gmail |
| 8 | **Nightly backup** | Schedule, nightly | n8n workflows + Postgres exported off-server |
| 9 | **Uptime check** | Schedule, every 15 min | Alert if n8n or the webhooks stop responding |

---

## 8. Build Order

**Before client #1**
1. [ ] Authorize the n8n connector in Claude settings
2. [ ] Deploy n8n + PostgreSQL (Docker Compose) on the primary host; pick the fallback host
3. [ ] Set up nightly backups and the uptime check (workflows #8–9)
4. [ ] Create Notion databases (`Targets`, `Clients`, `Recovery Claims`) and Postgres tables (`consent_log`, `opt_outs`, `message_log`)
5. [ ] Build the first target list: HVAC + plumbing, public records first, Clay for the top 50–100 rows
6. [ ] Build n8n workflows #1–2 (prospecting)
7. [ ] Build the A2P compliance site template in `ghl-a2p`
8. [ ] Get the one-page service agreement drafted or reviewed by a lawyer
9. [ ] Write message templates and have the lawyer review the sequence
10. [ ] Door-knock the A-tier list → close client #1

**After client #1**
11. [ ] Sign the agreement → set up the client's Twilio account → submit A2P → deploy the client's compliance site
12. [ ] Tag the list's consent status → check against DNC → segment
13. [ ] Build n8n workflows #3–7
14. [ ] Weeks 1–2: email + manual-call reactivation
15. [ ] Weeks 2–3: SMS for contacts with clear consent, once A2P is approved
16. [ ] Document results → case study → scale to 10 clients → Beaumont

---

## 9. Risk Register

| # | Risk | Severity | What we do about it |
|---|---|---|---|
| 1 | TCPA / Texas lawsuits over texts to people who didn't consent | **Critical** | Compliance gate, email first, consent log, DNC check, allowed hours, lawyer review |
| 2 | A2P approval delays | High | Start at signing; weeks 1–2 run on email and calls |
| 3 | GHL sub-accounts need an agency plan | Medium | Use Twilio directly; GHL only if the client already has it |
| 4 | Missing owner data (roofers, sole proprietors) | Medium | HVAC/plumbing first; manual fallback; Clay only for top rows |
| 5 | Clay free credits run out | Medium | Public records first; Clay for the top 50–100 rows; one table per trade |
| 6 | Free hosting capacity gets reclaimed or is unavailable | Medium | Nightly backups, uptime check, fallback host ready |
| 7 | n8n license | Low | Running your own automations for clients is fine under n8n's Sustainable Use License; reselling or white-labeling n8n itself isn't. Re-check before any client-facing n8n access. |
| 8 | Calendly free plan has no webhooks | Low | Use Cal.com (or a Google Calendar new-event trigger) |
| 9 | Notion outgrown or rate-limited | Low (for now) | Fine for 10 clients; Postgres already holds the high-volume logs; revisit at scale |
| 10 | Client under-reports recovered jobs | Medium | Tracking number, message log, unique booking link, right to check records in the contract |
| 11 | Client hesitant to pay for SMS setup | Medium | You float the first ~$100, recovered through the setup fee |

---

## 10. Tools Left Out on Purpose

| Tool | Reason |
|---|---|
| Make.com, Zapier | Replaced by self-hosted n8n (no run limits) |
| Airtable, HubSpot, Google Sheets | Replaced by Notion + Postgres |
| Calendly free | No webhooks on the free plan; Cal.com replaces it |
| GoHighLevel (by default) | Sub-accounts need an agency plan; Twilio is direct. Kept only for clients who already use GHL |
| Google Voice / personal phone for bulk SMS | Not allowed for mass texting; no A2P registration |

---

## Change Log

**Revision 2**
- Added the compliance layer (Section 4) and made it a gate inside workflow #3
- Email-first reactivation; SMS only for contacts with clear consent
- Switched SMS to Twilio by default, with one tracking number per client, and you float the first ~$100
- Replaced Calendly with Cal.com
- Put HVAC/plumbing ahead of roofing; added a manual owner-lookup fallback; limited Clay to the top 50–100 rows
- Added Postgres tables for consent, opt-outs and the message log
- Added nightly backups, an uptime check and a fallback host (workflows #8–9)
- Changed the fee model to setup fee + percentage, backed by evidence; added the service agreement
- Added the risk register

**Revision 1:** first stack outline
