# Chubby Support Agent

Cloud automation for Chubby Club support workflows.

## CHUBBY1 v0

Current mode: **read-only verification**.

The first workflow:

1. Receives a Freshdesk webhook.
2. Extracts the sender email and any phone number in the ticket content.
3. Normalizes both identifiers.
4. Checks the CHUBBY1 eligibility list.
5. Looks for a matching Stripe customer.
6. Returns a verification result.
7. **Does not apply a coupon, change Stripe, or reply to Freshdesk yet.**

## Required environment variables

- `WEBHOOK_SECRET` - shared secret expected in the `x-chubby-webhook-secret` header.
- `STRIPE_SECRET_KEY` - use a restricted Stripe key with read-only customer access for v0.
- `CHUBBY1_ELIGIBILITY_JSON` - JSON array of eligible records.

Example:

```json
[
  {"email":"person@example.com","phone":"6265551234","eligible":true}
]
```

## Endpoint

`POST /api/freshdesk/chubby1`

Expected JSON fields:

```json
{
  "ticket_id": 12345,
  "email": "person@example.com",
  "subject": "CHUBBY1",
  "message": "My phone is (626) 555-1234"
}
```

## Safety

If eligibility does not match, Stripe returns multiple plausible customers, or the request is malformed, the workflow stops and reports manual review.
