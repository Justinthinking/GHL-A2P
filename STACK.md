# RROS Stack Plan: Revenue Recovery for East Texas Contractors

Target market: roofing, HVAC and plumbing contractors with 2–5 trucks in the Tyler/Longview corridor.
Offer: database reactivation (re-contacting old, unclosed estimates), sold as an outcome.
Rule: $0 for tools until client #1 pays. SMS delivery is the only paid layer, and the client pays for it.

---

## 1. Stack at a Glance

| Layer | Tool | Version / Plan | Cost | Status |
|---|---|---|---|---|
| Owner lookup (primary) | Texas Comptroller, TDLR and TSBPE public lookups | Web portals | $0 | Ready to use |
| Targeting and enrichment | Clay.com | Free plan | $0 | To set up |
| Database / CRM / commissions | Notion (RROS workspace) | Free / current plan | $0 | Connected |
| Automation engine | n8n (self-hosted) | Latest stable, pinned at deploy | $0 | Connected, needs authorization |
| Automation database | PostgreSQL | 16 | $0 | Available |
| Queue / cache (optional) | Redis | 7 | $0 | Available |
| Containers | Docker + Docker Compose | 29.x | $0 | Available |
| Scripting runtimes | Node.js / Python | 22 LTS / 3.11 | $0 | Available |
| Email | Gmail | Google Workspace / free | $0 | Connected |
| Scheduling | Google Calendar + Cal.com or Calendly | Free plans | $0 | Calendar connected |
| Code and templates | GitHub (`ghl-a2p` repo) | Free | $0 | Connected |
| Compliance websites | GitHub Pages or Cloudflare Pages | Free | $0 | To build |
| Always-on hosting | Oracle Cloud Always Free (ARM) | Free tier | $0 | To set up |
| SMS delivery | GoHighLevel sub-account **or** Twilio | Starter plan / pay-as-you-go | Client pays | After client #1 |
| A2P 10DLC registration | Through GHL or Twilio | Per client brand | Client pays | Onboarding step 1 |
| AI assistant / builder | Claude Code | Current | Existing plan | Active |

---

## 2. Connections Map

```
                    ┌──────────────────────┐
  Public records ──►│                      │
  Clay (CSV) ──────►│   n8n (automation)   │◄──── Cal.com / Calendly (booking webhook)
                    │                      │
                    └───┬──────┬───────┬───┘
                        │      │       │
                        ▼      ▼       ▼
                    Notion   Gmail   Google Calendar
                  (database) (email) (follow-ups)
                        │
                        ▼
              GHL / Twilio (SMS, client-owned, A2P registered)
                        │
                        ▼
              Replies ──► n8n ──► Notion pipeline + owner alert

  GitHub (ghl-a2p) ──► GitHub/Cloudflare Pages ──► compliance site per client
```

| From | To | Method | Purpose |
|---|---|---|---|
| Public records | Notion | Manual entry or n8n import | Owner names for target list |
| Clay | Notion | CSV export → n8n import | Enriched target list |
| Notion | n8n | Native Notion node | Read/write targets, clients, claims |
| n8n | Gmail | Native Gmail node | Follow-up emails, daily digest |
| n8n | Google Calendar | Native node | Door-knock follow-up reminders |
| Cal.com / Calendly | n8n | Webhook | Booked re-estimate → pipeline update |
| n8n | GHL / Twilio | Native node / HTTP | Send reactivation SMS |
| GHL / Twilio | n8n | Webhook | Inbound replies → intent tagging |
| GitHub | Pages host | Auto-deploy on push | Client A2P compliance websites |
| Claude Code | GitHub, Notion, Gmail, Calendar, n8n | Connectors | Build, update and operate the stack |

---

## 3. Phase 1: Targeting (Door-Knock Reconnaissance)

**Goal:** a printed route sheet with the owner's name, trade, main service and estimated ticket size.

1. **Source the businesses:** Clay Google Maps search by trade and zip code (75701, 75703, 75601, 75604).
2. **Filter:** 5–15 employees (a stand-in for 2–5 trucks). Flag businesses with 50+ Google reviews as A-tier.
3. **Find owner names, free sources first:**
   - Texas Comptroller franchise-tax search: officers/members of LLCs and corporations
   - TDLR license search: HVAC license holders
   - TSBPE license search: plumbing license holders
   - Clay waterfall (Apollo → Prospeo → Hunter): only for rows still missing an owner
4. **Claygent (Clay's AI web scraper):** main high-ticket service plus estimated average ticket.
5. **Export:** CSV → n8n → Notion `Targets` database → printed route sheet.

---

## 4. Phase 2: Fulfillment (Database Reactivation)

**Goal:** recover revenue from each client's old, unclosed estimates and prove it in a pipeline.

1. **Onboarding step 1:** A2P 10DLC registration in the client's business name.
2. **Compliance site:** generate from the `ghl-a2p` template (privacy policy, SMS terms, opt-in form).
3. **List prep:** client exports their old estimates → segment by service type and recency → tag (e.g. `Graveyard_Fall26`).
4. **Sequence:**
   - Day 0: SMS (short, personal, from the owner's name)
   - Day 1–2: wait
   - Day 2: email to non-responders with a booking link
5. **Reply handling:** n8n tags intent (positive / thinking / not interested / opt-out) → alerts the owner → updates Notion.
6. **Pipeline stages:** Reactivation Sent → Responded (Positive) → Re-Estimate Booked → Job Won.

---

## 5. Phase 3: Tracking and Getting Paid

| Notion Database | Key Fields |
|---|---|
| `Targets` | Business, Address/Zip, Phone, Owner, Trade, Main Service, Est. Ticket, Tier, Door-Knock Status, Next Follow-Up |
| `Clients` | Name, Trade, Avg Ticket, Fee Model, Campaign Start, A2P Status, Total Recovered |
| `Recovery Claims` | Client (relation), Contact, Job Type, Job Value, Fee Owed (formula), Status (Pending / Confirmed / Paid), Date |

- **Proof of recovery:** unique booking link per campaign + client confirms each job won.
- **Invoice:** Notion view of Confirmed claims → exported monthly.
- **Fee model:** pick one per offer: $2,500 flat **or** a percentage of recovered job value.

---

## 6. n8n Workflows to Build

| # | Workflow | Trigger | Output |
|---|---|---|---|
| 1 | Target import | Manual (CSV upload) | Rows in Notion `Targets` |
| 2 | Daily follow-up digest | Schedule, 7 AM | Gmail summary + Calendar reminders |
| 3 | Reactivation sequence | Notion/GHL tag applied | SMS → wait → email |
| 4 | Reply intent router | SMS reply webhook | Notion stage update + owner alert |
| 5 | Booking capture | Booking webhook | Notion stage → Re-Estimate Booked |
| 6 | Recovery claim | Job-won form/webhook | Row in `Recovery Claims` |
| 7 | Monthly invoice | Schedule, 1st of month | Confirmed-claims summary via Gmail |

---

## 7. Build Order

1. [ ] Authorize the n8n connector in Claude settings
2. [ ] Deploy n8n + PostgreSQL (Docker Compose) on always-on free hosting
3. [ ] Create Notion databases: `Targets`, `Clients`, `Recovery Claims`
4. [ ] Build the first target list (public records + Clay)
5. [ ] Build the A2P compliance site template in `ghl-a2p`
6. [ ] Build n8n workflows 1–2 (prospecting)
7. [ ] Door-knock A-tier list → close client #1
8. [ ] Set up the client's SMS account + A2P registration
9. [ ] Build n8n workflows 3–7 (fulfillment and tracking)
10. [ ] Launch the first campaign → document results → scale to 10 clients

---

## 8. Tools Left Out on Purpose

| Tool | Reason |
|---|---|
| Make.com, Zapier | Replaced by self-hosted n8n (no run limits) |
| Airtable, HubSpot, Google Sheets | Replaced by Notion (one source of truth) |
| Google Voice / personal phone for bulk SMS | Not allowed for mass texting; no A2P registration |
