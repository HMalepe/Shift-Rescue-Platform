# LOCUM PLANNER — PRODUCT & TECHNICAL SPECIFICATION
Two-Sided Marketplace for South African Pharmacy Locum Management

---

## 0. PHASE 0 — VERIFICATION ENVIRONMENT

The readiness checklist requires attacking auth, forcing vendor errors, degrading
endpoints, observing query plans at scale, and confirming alerts page a human. None of
these are possible against a local dev machine or a mocked test suite. Phase 0 builds the
place where gates get passed, ahead of all feature work.

### 0.1 Staging Environment

- Deployed, reachable at a stable URL, separate database from production
- Redeployable from a single command; teardown/rebuild must be cheap enough that a
  destructive security test is not scary
- Environment parity where it matters: same Postgres major version, same PostGIS
  version, same managed host as production intent. Row-level locking and query-planner
  behaviour do not port from SQLite or a different PG version.
- Feature-flagged from production data entirely; no real SAPC certificates ever land here

### 0.2 Vendor Sandboxes, Wired and Breakable

Not just connected — forceable into failure. For each vendor, document the specific
mechanism used to induce each failure mode:

| Vendor | Failure modes that must be inducible on staging |
|---|---|
| Payfast/Ozow | Settlement-day outage, card decline, retry success, timeout mid-charge |
| Twilio | Send failure, delivery-status webhook retry (duplicate `MessageSid`), template rejection, rate-limit response |

### 0.3 Load Harness

Committed to the repo, parameterised by concurrency and dataset size, runnable against
staging by anyone on the team with one command.

### 0.4 Single-Command Verification Run

`make verify` (or equivalent) runs the full automated suite and exits non-zero on failure.

**Exit criterion for Phase 0:** a deliberately broken endpoint on staging produces an alert,
and the load harness runs end-to-end against seeded data, before Phase 1 feature work is
considered started.

---

## 1–10. VISION, MONETIZATION, PERSONAS, MANAGER/LOCUM EXPERIENCE, MESSAGING, REPUTATION, LOCATION, CANCELLATION, PRIVACY

Problem/solution framing and phased rollout (§1); flat monthly subscription model and
subscription dunning/collections flow (§2); personas (§3); manager experience including
quiet-hours notification suppression and booking-confirmation row-locking (§4); locum
experience and the verified-vs-complete distinction (§5); time-gated messaging with regex
disintermediation detection (§6); unified reputation tiers with density-aware
anonymization (§7); opt-in check-in/check-out with anti-spoofing signals (§8); reframed
cancellation service fees (§9); POPIA compliance flags (§10).

---

## 10.0 MONEY FLOW — SCOPE BOUNDARY

**The platform never touches locum wages.** This is a hard architectural and legal boundary,
not a phase-1 simplification to revisit later.

| Flow | In scope? |
|---|---|
| Pharmacy → Locum Planner: flat monthly subscription | **Yes** — the only revenue line |
| Pharmacy → Locum Planner: R10 added to the month's subscription for a confirmed shift cancelled with under 24 hours' notice | **Yes** — accountability mechanism, not a revenue driver |
| Pharmacy → Locum: wages for shifts worked | **No.** Handled by each pharmacy's own payroll/HR, across many different employing entities. The platform does not hold, route, escrow, disburse, or take a percentage of this money. |

The platform's role in wages is limited to producing an **hours-worked record** (check-in/
check-out, §8) that a pharmacy can hand to its own payroll process. Nothing more.

**Why the boundary matters technically:** it removes the platform from being a payment
intermediary for wages entirely. Payfast/Ozow integration exists solely for collecting the
monthly subscription. The dunning state machine (§2) applies to a pharmacy's failed
subscription charge — not to anyone's pay.

**Why it matters legally:** it materially reduces exposure on the employment
misclassification question. A platform that pays locums looks far more like an employer or
a labour broker than one that introduces two parties and records attendance. This should
be stated explicitly to the attorney reviewing the BCEA/LRA question.

---

## 10.1 SHIFT VISIBILITY & CONTACT PRIVACY

Two manager-side complaints surfaced directly from live usage of the current informal
process (WhatsApp groups): a posted shift is visible to everyone in the group whether the
manager wants that reach or not, and booking through WhatsApp routes the locum straight
to the manager's personal number.

**Visibility control on posting:** when a manager posts a shift or toggles "Looking for a
Locum," the default reach is saved/favourited locums only. Expanding to a wider radius is
an explicit, separate action the manager takes — not the default. This is distinct from the
existing proximity-matching logic (§4.4/§12.3), which determines *ranking* once a shift is
already visible to a given pool; this section determines the *size of that pool* in the first
place.

**No personal numbers exchanged:** all messaging, including the free-form session-window
replies described in §11.3, routes through the platform's own WhatsApp business sender
(§11.1) — never a manager's or locum's personal number. This is already implied by the
Twilio/WhatsApp architecture in §11, but is stated here explicitly as a product requirement,
not just a technical side effect: a manager should never need to give out, or receive, a
personal number to complete a booking.

---

## 11. WHATSAPP MESSAGING VIA TWILIO

### 11.1 Provider & Sender Setup

Twilio is the WhatsApp Business API provider, reusing the existing Twilio account already
in place for the booking agent.

Provision a separate WhatsApp sender number for Locum Planner, within the same Twilio
account. Do not reuse the booking agent's number. A shared number conflates
conversation context for users (a manager getting a subscription reminder from the same number
as an unrelated booking-agent interaction), and it makes Twilio-console-level analytics
(message volume, delivery rate, cost) impossible to separate cleanly per product.

Meta Business Manager for this account is already verified, and the same Twilio account
already runs a live, Meta-approved WhatsApp bot. What remains, all on the
already-verified entity:

- Register the second sender in the Twilio Console — hours, Twilio-side
- Display name approval for the new sender — Meta reviews this per-sender; typically
  fast, but the one step that can still stall (generic or ambiguous names get kicked back)
- New templates submitted under this sender — the existing bot's approved templates
  don't transfer, since they belong to a different sender/use case; typically hours to 48h
  unless a template reads as vague or promotional

### 11.2 Template Categorization

Every proactive (business-initiated) message must be submitted to Meta as an approved
template, tagged into one of three categories — misclassification results in template
rejection or retroactive re-review:

| Category | Examples in this product | Cost/scrutiny profile |
|---|---|---|
| Utility | Booking confirmed, subscription payment reminder, shift starting soon, availability-lapse nudge | Lower cost, faster approval — transactional/account-related |
| Marketing | "Upgrade to Premium," referral program nudges, re-engagement campaigns | Higher cost, stricter opt-in enforcement, more aggressively throttled if users mute |
| Authentication | Not currently used in this product (no OTP-via-WhatsApp planned) | N/A |

Classify each message type at template-submission time, not after — a template
resubmitted under a different category restarts Meta's review clock.

### 11.3 Session Window Logic (24-hour rule)

WhatsApp Business API distinguishes free-form replies (available for 24 hours after a user
last messaged you) from business-initiated messages (always require an approved
template, regardless of recency). This must be an explicit branch in the send logic:

- User-initiated / within session window: e.g. a manager replying to a subscription reminder, or
  asking a logistics question — free-form reply permitted.
- Business-initiated: booking confirmations, availability-lapse nudges, proactive-match
  notifications — always template-based, every time, with no exception for "but they
  messaged us yesterday."

Build this as a single shared `sendWhatsAppMessage(type, ...)` function that resolves
template-vs-freeform internally, rather than leaving each call site to decide — a missed
branch here is a silent failed send, not a visible error.

### 11.4 Consent — Separate From POPIA Onboarding Consent

Meta requires its own explicit WhatsApp opt-in, distinct from the platform's general POPIA
consent captured at onboarding. Needs:

- A dedicated opt-in checkbox/flow at the point WhatsApp is offered as a channel (not
  folded into a general "I agree to be contacted" checkbox)
- A working opt-out path — a user texting "STOP" must actually suppress future template
  sends, tracked per-user, and surfaced back into the notification-preferences UI

### 11.5 Webhook Idempotency (Inbound)

Twilio retries webhook delivery on timeout or non-2xx response. Delivery-status webhooks
(`delivered`, `read`, `failed`) and inbound message webhooks must be deduplicated on
Twilio's `MessageSid`/`SmsSid` before being processed, using the same idempotency_keys
pattern used elsewhere in this spec, keyed on the Twilio SID instead of a client-generated
key.

### 11.6 Cost Control

Quiet-hours suppression (§4.4) queues notifications for delivery at 07:00 — if a bug causes
a large backlog to build up, that queue could fire a burst of billable business-initiated
conversations simultaneously. Add:

- A soft daily spend cap per notification type, with alerting (not hard-blocking) when
  threshold is crossed
- A dashboard showing daily WhatsApp conversation count and spend, checked as part of
  the same on-call rotation covering the rest of the platform (§13)

### 11.7 Delivery Status Tracking

Wire up Twilio's delivery/read-receipt webhooks explicitly — a "sent" event in analytics
with no corresponding delivery/read confirmation is not evidence anything actually reached
anyone, and undermines the WhatsApp-vs-push open-rate comparison the marketing plan
relies on.

```sql
whatsapp_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_sid VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id),
  template_type VARCHAR(50), -- 'booking_confirmed', 'subscription_reminder', etc.
  category VARCHAR(20), -- 'utility', 'marketing'
  direction VARCHAR(10), -- 'outbound', 'inbound'
  status VARCHAR(20), -- 'queued', 'sent', 'delivered', 'read', 'failed'
  status_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
)
```

---

## 12. TECHNICAL ARCHITECTURE — EXTENDED

Stack, PostGIS geospatial layer, and full schema per §11.1–11.4 retained. Extensions below.

### 12.1 Security Review Scope

Minimum scope before launch:

- Auth: token expiry/refresh strategy, session invalidation on password change, rate
  limiting on login/signup endpoints to prevent credential stuffing
- File uploads: SAPC certificates, payslips, employment letters — validate file
  type/size server-side, scan for malware before storage, and ensure signed URLs for
  retrieval expire rather than granting permanent public access to documents containing
  personal/employment data
- Rate limiting on public endpoints: search/browse endpoints, booking-request creation —
  prevent scraping of locum personal data and abuse of the notification-firing booking flow
- Admin verification queue as a social-engineering target: an admin account with the
  power to mark employment "verified" is a high-value target; require MFA on all admin
  accounts, and log every verification decision with the reviewing admin's identity
- Third-party vendor failure modes: what happens to booking confirmation if Payfast has
  a settlement-day outage, or Twilio's WhatsApp API has an incident — degrade
  gracefully (queue and retry) rather than failing the underlying booking/subscription action

### 12.2 Observability & On-Call

Minimum viable plan before launch:

- Error tracking: Sentry actually wired into alerting, not just collecting errors silently
- Uptime/latency monitoring on booking-confirmation, check-in/check-out, and
  subscription-billing endpoints specifically — booking and attendance downtime stops a
  pharmacy trading; billing downtime costs revenue
- On-call rotation defined, even informally for a small team — who gets paged, for what
  severity, and what the response-time expectation is
- Dashboard covering: booking confirmation success rate, WhatsApp delivery/spend
  (§11.6–11.7), settlement/dunning success rate, and PostGIS query latency as usage grows

### 12.3 Load Testing Gate

Phase 3's proactive-matching feature is explicitly designed to fire a notification burst the
instant a manager toggles "Looking for a Locum" — pushing to favorited locums, then
expanding by distance/reliability. This is exactly the kind of feature that behaves fine at 10
users in a demo and falls over at 500 in production.

Gate: run a load test simulating realistic concurrent toggle events (with realistic
favorited-locum list sizes) before Phase 3 ships to real users, not after. This should
specifically exercise the booking-confirmation row-locking under concurrent accept
attempts, and the notification fan-out path under a burst, together — not as separate unit
tests.

### 12.4 Acceptance-Test-First Requirement

For each of the six code gates in the readiness checklist, the test is written with the
feature, and must satisfy a mutation check: remove the fix, and the test must fail. A test
that passes both with and without the fix verifies nothing.

### 12.5 Gate Status as Data

Gate status recorded only in a document drifts from reality within days. Record it in the
system:

```sql
verification_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id       VARCHAR(64) NOT NULL,   -- 'code.concurrency', 'security.auth_rate_limit'
  clock         VARCHAR(1)  NOT NULL,   -- 'A' generation | 'B' execution | 'C' external
  status        VARCHAR(20) NOT NULL,   -- 'not_started','generated','executed','passed','failed','waived'
  evidence_url  TEXT,                   -- CI run, EXPLAIN output, legal opinion PDF, Meta approval screenshot
  executed_by   VARCHAR(120),           -- human or CI identity
  notes         TEXT,
  executed_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
)
```

A gate cannot move to `passed` without a non-null `evidence_url`.

---

## 13. LOCATION & ATTENDANCE, CANCELLATION, PRIVACY, PHASED ROADMAP, NORTH STAR

- **Phase 0 (precedes Phase 1):** verification environment per §0.
- **Day 0 (parallel, no build dependency):** legal briefs sent; Twilio sender registered
  under the already-verified WABA and new display name submitted; Payfast account
  opened; PostGIS support on the intended managed host confirmed; external security
  reviewer engaged.
- **Phase 2 (Month 3):** Twilio WhatsApp templates submitted and cleared as a parallel
  workstream.
- **Phase 3 (Month 4):** load-testing gate (§12.3) as an explicit exit criterion.

---

## 14. TEST FIXTURES & DATA GENERATION

Buildable scope, generatable from this spec, and a hard prerequisite for §5 of the
readiness checklist. Without it, "test at realistic row counts" has no mechanism.

Seed generator must produce:

- 5,000+ locum rows with realistic ZA coordinate distribution — clustered around Gauteng
  metro density, not uniformly random. Uniform random coordinates make proximity
  queries look artificially well-distributed and hide the index behaviour being observed.
- 200+ pharmacy rows with realistic geographic clustering
- Configurable favorited-locum list sizes, defaulting to 10× projected Month-6 numbers
- Booking history across all states: open, accepted, completed, cancelled-by-locum,
  cancelled-by-manager, disputed
- Subscription dunning fixtures: pharmacy accounts in decline, retry, restricted and
  dispute-flagged states
- Malicious upload fixture set: oversized file, disguised executable, malformed
  parser-exploit file — committed as test assets, so the file-upload security gate is
  runnable rather than aspirational
- Duplicate-webhook fixtures: repeated Twilio `MessageSid` payloads for the inbound
  idempotency test

Disintermediation corpus: ≥200 hand-labelled messages spanning true positives (phone
numbers, "call me," "let's sort this directly") and known false positives ("call the
pharmacy," "the manager will call you about the roster"). Generatable as a starting draft;
must be human-reviewed for labels before a false-positive rate derived from it means
anything.

---

## 15. GENERATION vs. EXECUTION

Every deliverable in this spec is one of three types.

| Type | Definition | Closes a gate? |
|---|---|---|
| G — Generatable | Claude Code can produce it correctly from this spec | No — produces the artifact that makes execution possible |
| X — Execution-required | Must be run against a live environment and observed | Yes — this is where gates actually close |
| E — Externally-blocked | Depends on a third party | Yes — closes on written return |

| Deliverable | Type | Note |
|---|---|---|
| Concurrency test | G → X | Generated easily; must run against real PG row-locking |
| Idempotency test | G → X | |
| PostGIS `EXPLAIN ANALYZE` verification | X | Cannot be closed by reading code. Requires seeded data + execution. |
| Anti-spoofing on real device | X | Requires physical Android hardware |
| Disintermediation false-positive rate | G (harness) → X + human labelling | The number does not exist until measured |
| Dunning state machine | G → X | Requires Payfast sandbox in error state |
| Auth/upload/scraping attacks | G (scripts) → X | Scripts are trivially generatable; running them is the gate |
| Signed URL expiry | X | Manual, time-dependent |
| Sentry paging a human | G (wiring) → X | The gate is that a phone buzzes |
| Load tests | G (harness) → X | A load test not run is not a load test |
| Legal opinions ×5 | E | Day 0 |
| New sender + display name approval | E | Day 0, hours-to-days |
| Template approval | E | Follows sender, hours to 48h |
| External security review | E | Day 0 |
| PostGIS host support | E | Day 0, ~20 min |

The spec's thoroughness compresses the G column close to zero — that's the genuine payoff
of specifying this heavily. It does not compress X or E at all. X starts only once Phase 0
exists; E starts whenever someone sends an email or opens a console, which is why E
starts today.

---

## 16. PHYSICAL & HUMAN-DEPENDENT VERIFICATION

Neither generatable nor automatable.

| Item | Requirement | Schedule |
|---|---|---|
| Anti-spoofing signal capture | At least one physical Android device with a mock-location app installed and active. Emulator confirmation is explicitly insufficient — the signals being captured are precisely the ones an emulator misrepresents. | Acquire device during Phase 0 |
| Disintermediation label review | A human reads and labels the ≥200-message corpus (§14). A false-positive rate measured against machine-generated labels measures the generator, not the regex. | Phase 1, parallel with build |
| On-call human | A named person with a stated response-time expectation per severity | Today. Zero cost, zero dependency. |
