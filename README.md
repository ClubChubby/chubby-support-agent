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
Current mode: **read-only verification**.

The first workflow:

1. Receives a Freshdesk webhook.
2. Extracts emails and phones from the ticket content and also considers the requester email.
3. Normalizes both identifiers.
4. Checks the CHUBBY1 eligibility list.
5. Looks for a matching Stripe customer.
6. Returns a verification result.
7. **Does not apply a coupon, change Stripe, or reply to Freshdesk yet.**

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
- `CHUBBY1_ELIGIBILITY_JSON`

## Endpoints

- `POST /api/freshdesk/intake` — general support intake/router
- `POST /api/freshdesk/chubby1` — CHUBBY1 workflow

## Safety

The agent should use deterministic rules for consequential actions such as eligibility, refunds, discounts, and account changes. AI can classify or interpret messages, but sensitive actions must follow explicit workflow rules and approval thresholds.

## Intake verification and testing

The intake endpoint runs the shared CHUBBY1 verification internally when the
classifier selects `chubby1`. It returns the classification alongside
`verified_read_only`, `not_eligible`, or `manual_review`, with
`actionTaken: false`. Other workflows remain classification-only.
Both endpoints still require `WEBHOOK_SECRET`.

Run `npm test` with Node.js 24 or later. Tests mock the Stripe SDK boundary;
they do not contact Stripe or Freshdesk.

After deployment, create a Freshdesk ticket with subject exactly `AGENTTEST`
and mention `CHUBBY1` in the body. Use the existing eligible test sender email
and phone. Expect `verified_read_only` only when exactly one Stripe customer
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
details. No environment changes are required for existing rows with emails.

For an on-behalf test, use a requester absent from the list and put an approved
record's email or phone in a new AGENTTEST ticket containing CHUBBY1 or Chubby 1.
Expect `verified_read_only` for the approved account, not the requester.
Then test conflicting approved records (`manual_review`) and unlisted
identifiers (`not_eligible`). Use `{{ticket.description_text}}` as the
creation webhook's message field. All actions remain read-only.

Check the webhook response as well as the HTTP status: HTTP 200 can also mean
`manual_review` or `not_eligible`. No coupon, Stripe mutation, Freshdesk reply,
or ticket resolution occurs.
