# Chubby Support Agent

Cloud automation for Chubby Club support workflows.

## Purpose

This project is a broader **Chubby Support Agent** that can classify, investigate, draft, and eventually resolve different customer-support requests.

CHUBBY1 is the first production workflow, not the limit of the system.

## Initial capabilities

### 1. General support intake
Every incoming Freshdesk ticket can be classified into a workflow such as:

- CHUBBY1 promotion
- Membership cancellation
- Billing / duplicate charge
- Refund request
- Account access
- Membership benefits question
- Promotion eligibility
- Location / restaurant issue
- App issue
- General FAQ
- Unknown / manual review

### 2. CHUBBY1 workflow
Default mode: **read-only verification**. Customer coupon application is implemented behind a production-only release switch.

The first workflow:

1. Receives a Freshdesk webhook.
2. Extracts emails and phones from the ticket content and also considers the requester email.
3. Normalizes both identifiers.
4. Checks the CHUBBY1 eligibility list.
5. Looks for a matching Stripe customer.
6. Returns a verification result.
7. In explicitly enabled pilot/live mode, attaches the coupon to the approved Stripe customer after additional checks. Freshdesk replies and resolution remain disabled.

## Architecture

```
Freshdesk
   ↓
Support intake / classifier
   ↓
Workflow router
   ├── CHUBBY1
   ├── Billing
   ├── Cancellation
   ├── Refund
   ├── Account access
   ├── Benefits / FAQ
   └── Manual review
```

Each workflow gets its own rules, permissions, integrations, and safety limits.

## Required environment variables

- `WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `CHUBBY1_ELIGIBILITY_KEY` — private AES-256 key; never commit it

## Endpoints

- `POST /api/freshdesk/intake` — general support intake/router
- `POST /api/freshdesk/chubby1` — CHUBBY1 workflow

## Safety

The agent should use deterministic rules for consequential actions such as eligibility, refunds, discounts, and account changes. AI can classify or interpret messages, but sensitive actions must follow explicit workflow rules and approval thresholds.

## Intake verification and testing

The intake endpoint runs the shared CHUBBY1 verification internally when the
classifier selects `chubby1`. It returns the classification alongside
`preview_ready_read_only`, `not_eligible`, or `manual_review`, with
`actionTaken: false`. Other workflows remain classification-only.
Both endpoints still require `WEBHOOK_SECRET`.

Run `npm test` with Node.js 24 or later. Tests mock the Stripe SDK boundary;
they do not contact Stripe or Freshdesk.

After deployment, create a Freshdesk ticket with subject exactly `AGENTTEST`
and mention `CHUBBY1` in the body. Use the existing eligible test sender email
and phone. Expect `preview_ready_read_only` only when exactly one Stripe customer
matches the approved eligibility record. A noneligible identifier returns `not_eligible`;
missing or multiple Stripe matches return `manual_review`.
A phone in the ticket can select an approved record; that record must contain
an email or `stripeCustomerId` to locate the Stripe account. The sender need
not own the approved account.

## Approved account matching

All emails and phones from the subject/description, plus the requester email,
are compared with rows having `eligible: true`. Exactly one matching row is
required. Multiple matching rows (including duplicates or a sender and recipient
who each have their own approved row) return `multiple_eligible_records` for
manual review, without contacting Stripe.

Stripe lookup uses only the matched row's `stripeCustomerId` (preferred), or
its normalized `email` when no ID is configured. Ticket-provided Stripe IDs
are ignored. Missing/deleted IDs never fall back to another account.
An approved phone-only row without either destination identifier returns
`approved_account_identifier_missing`. Invalid configured IDs return
`invalid_approved_stripe_customer_id`.

Example eligibility row:
```json
{"email":"approved@example.com","phone":"6265551234","stripeCustomerId":"cus_approved","eligible":true}
```
The ID is optional; replace example values with the approved account's real
details. The current production list comes only from the supplied promotion-recipient CSV, not from arbitrary environment rows.

For an on-behalf test, use a requester absent from the list and put an approved
record's email or phone in a new AGENTTEST ticket containing CHUBBY1 or Chubby 1.
Expect `preview_ready_read_only` for the approved account, not the requester.
Then test conflicting approved records (`manual_review`) and unlisted
identifiers (`not_eligible`). Use `{{ticket.description_text}}` as the
creation webhook's message field. All actions remain read-only.

Check the webhook response as well as the HTTP status: HTTP 200 can also mean
`manual_review` or `not_eligible`. No coupon, Stripe mutation, Freshdesk reply,
or ticket resolution occurs.

## Promotion recipient list and coupon preview

The authoritative source is the user-supplied
Former Members – No Active Membership (2026-09-20) -- 09-23-26.csv:
14,828 records. All rows are promotion recipients per the owner's instruction.
The filename alone does not establish current subscription status; Stripe is
checked live. CSV userId values are not Stripe customer IDs and are not used as such.
Only email and phone are retained in the runtime allowlist.

The list is bundled as compressed AES-256-GCM ciphertext in
`lib/approved-list-data.js`. Its key is stored separately in private Vercel
configuration as `CHUBBY1_ELIGIBILITY_KEY`. Missing/wrong keys fail closed.
The previous `CHUBBY1_ELIGIBILITY_JSON` test list is ignored in production.
Never commit the source CSV, decrypted JSON, or key.

After a unique approved Stripe customer is found, both endpoints retrieve
coupon `9MSuudHO`, that customer, and all subscription pages.
Expected coupon: valid, fixed USD 87.00 (`amount_off: 8700`).
Coupon duration is reported as configured; no duration is assumed.

- Active subscription, including cancel-at-period-end: `not_eligible`, reason `active_subscription`.
- Past due alone: permitted.
- Existing customer, current subscription, or subscription-item discount: `manual_review`, reason `existing_discount`.
- Trialing, paused, unpaid, incomplete, or unknown status: manual review.
- Canceled/incomplete-expired subscriptions do not disqualify; their historical discounts are not treated as current.
- Invalid/unavailable coupon, wrong value/currency, unexpected product restrictions, incomplete reads, and API failures: manual review. The confirmed product restriction is Chubby Club PLUS (`prod_RE0j1f8IisV0EI`).
- Passing all checks: `preview_ready_read_only`, with coupon, approved customer,
  subscription statuses, and `actionTaken: false` in the authenticated response.
  Logs include status/reason and preview eligibility, never customer identifiers.

The default qualification preview and direct CHUBBY1 endpoint perform reads only.
Only general intake can invoke the gated application workflow described below.

Keep the AGENTTEST restriction. Test a listed account with no active subscription,
an active account, a past-due account, an account with an existing discount,
and an identifier absent from the recipient CSV. Only the last case should
stop before contacting Stripe; list ambiguities also stop before Stripe.

## Controlled coupon application

Application attaches coupon `9MSuudHO` to the **approved Stripe customer**.
Members finish checkout in the existing app; this service never creates a
subscription, invoice, charge, checkout link, or Freshdesk response.
Stripe API version is pinned to `2024-06-20` for customer-level coupon and
`discount` fields. Product restrictions are explicitly expanded when reading
coupons. Live writes require a live customer and coupon, USD 87, duration once,
and exactly the confirmed Chubby Club PLUS product restriction.

Release configuration (private Vercel Production environment only):

- Unset `CHUBBY1_APPLICATION_MODE`: read-only (default and kill switch).
- `CHUBBY1_APPLICATION_MODE=pilot`: writes only to IDs explicitly listed in
  `CHUBBY1_PILOT_CUSTOMERS` (comma-separated). AGENTTEST is permitted for those
  accounts only. The promotion-list and all other checks still apply.
- `CHUBBY1_APPLICATION_MODE=live`: processes real CHUBBY1 tickets; any subject
  containing AGENTTEST remains read-only. Nonproduction Vercel deployments
  never write, regardless of these settings.

Before a mutation the agent scans paginated subscription and invoice history
for prior CHUBBY1 use, and repeats current customer/coupon/subscription checks.
Unexpanded, failed, or incomplete history is manual review. Historical CHUBBY1
attachments, including void invoices, conservatively require review.
Other existing discounts are never deliberately replaced.

One Stripe customer update writes both the coupon and permanent metadata key
`chubby1_202609_applied=9MSuudHO:v1`. A deterministic, hashed idempotency key
is identical across tickets. Stripe handles concurrent retries; the permanent
marker prevents later reapplication after the discount is consumed and the
Stripe idempotency cache expires. Do not remove this marker. No personal data
is placed in the idempotency key or metadata. Pre-existing metadata is preserved.
External administrators can still change the account between the final read
and the update: Stripe customer updates do not provide a conditional write.
Coordinate manual coupon edits during the pilot.

Success: `coupon_applied`, `actionTaken:true`. A previous agent marker returns
`already_applied` without another write when the application function is reached.
The intake may instead report `existing_discount` if that earlier guard stops it.
An uncertain mutation is `manual_review`, `application_outcome_unknown`,
`actionTaken:null`; inspect Stripe before any manual retry. Do not change the
idempotency key to work around a timeout. Logs contain numeric ticket IDs and
outcome fields, never member contact details or the eligibility list.

### Release procedure

1. Deploy with mode unset; check a new AGENTTEST log on the pinned API version.
2. Select one approved account whose owner can complete app checkout; confirm
   it has no active membership or current discount. Configure only its Stripe
   ID in pilot mode. Do not reuse arbitrary QA accounts for real discounts.
3. Submit a fresh AGENTTEST ticket, inspect `coupon_applied` and the Stripe
   customer coupon/marker, then verify the app shows the correct discounted
   Chubby Club PLUS checkout. Payment is completed by the account owner.
4. Retry the same ticket and a second request for that account; verify no second
   application. Check timeout and failure handling in the automated suite.
5. After the pilot, set live mode and expand the existing Freshdesk automation
   beyond AGENTTEST to the intended CHUBBY1 traffic. Until then real ticket
   processing is not launched. Keep replies/resolution disabled.
6. Disable by removing the mode setting and redeploying. This stops subsequent
   executions; already-running calls may finish and applied coupons are not undone.

No live activation or app-checkout pilot has been completed by this commit.
The 66 automated tests mock Stripe and do not prove live write permissions or
in-app checkout behavior. Past-due and existing-discount rules have automated
coverage; their dedicated live cases remain pending.

### Owner-authorized one-account test exception

An owner can explicitly authorize a test account outside the promotion list.
Set private `CHUBBY1_PILOT_TEST_ACCOUNT` to JSON containing `email`, `phone`,
`stripeCustomerId`, and `expiresAt` (epoch milliseconds, at most 24 hours ahead).
It only matches production pilot intake with subject exactly AGENTTEST, both
matching email and phone, and a customer also in CHUBBY1_PILOT_CUSTOMERS.
It cannot override an ambiguous list match, affect the direct read-only route,
or run in live mode. Subscription, discount and prior-use checks remain enforced.
Do not commit the actual values. Remove the setting after the pilot.


### Cody-only Freshdesk scope (required for all intake)

Configure Production `FRESHDESK_API_KEY` privately and `FRESHDESK_CODY_AGENT_ID`
with Cody Choi's verified Freshdesk agent ID. Never commit or log the API key.
The service makes GET requests only to chubbyclub.freshdesk.com. Missing access,
API errors, invalid data, or incomplete history stop processing without a coupon.

Both endpoints load the current ticket and require assignment to Cody before
classification or member lookup. Webhook text/assignment/reply claims are ignored;
content comes from the ticket API. All conversation pages are checked, rather
than the ten-item embedded history. Any reply authored by Cody blocks processing,
including replies sent via email. His public notes also conservatively block;
private notes and other agents' replies do not. Skips report `not_assigned_to_cody`
or `cody_already_replied` without logging message bodies or personal data.

Immediately before the Stripe write, the assignment/history check runs again.
A changed ticket since verification stops processing. Freshdesk and Stripe do
not share an atomic transaction: a human reply/reassignment after the final
check can still race the Stripe update. Coordinate manual handling during rollout.

Keep the Freshdesk trigger limited to Cody Choi and CHUBBY1/Chubby 1 traffic.
Do not activate broad live traffic until these API-backed checks pass deployed
AGENTTEST cases (Cody/unreplied, another assignee, and Cody already replied).
This change does not create a recurring inbox scanner or process old tickets.
It handles authenticated webhook events; ticket-creation and assignment-update
rules must be configured explicitly for the desired future events.

### Authorized one-time backlog pass

A one-time pass can use a frozen list of ticket IDs selected from Freshdesk's
Open / Cody Choi view (all creation dates). Store that list only in private
Production configuration `CHUBBY1_BACKFILL`, never in this public repository:
`{runId, requesterId, expiresAt, ticketIds}`. runId is 32 lowercase hex characters;
requesterId is the operator's test contact; expiresAt is epoch milliseconds at
most four hours ahead; ticketIds is a unique array of at most 300 numeric strings.

An authenticated webhook for a Cody-assigned, unreplied operator control ticket
with subject `CHUBBY1 BACKFILL <runId> BATCH <N>` triggers 25 configured IDs per
batch. The ticket cannot choose targets, extend expiry, or enable the feature.
The trusted API requester must match configuration. Production live mode is
required. Each target must STILL be Open, Cody-assigned and unreplied; these
conditions are checked again immediately before mutation. AGENTTEST tickets
are skipped, and the owner pilot exception is disabled. Replays retain all
per-customer idempotency and permanent coupon-history protections.

Requests are paced. Per-ticket outcomes are logged as freshdesk_backfill_result
with numeric ticket ID and outcome only. No comments, replies, status changes,
or recurring scans are created. Check that every frozen target has an outcome;
API failures remain manual review and can be explicitly retried after recovery.
After completion, set CHUBBY1_BACKFILL to `disabled` and redeploy. Running batches
also stop on expiry; already-running Stripe calls cannot be atomically canceled.
