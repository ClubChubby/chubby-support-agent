import { extractPhones, normalizeEmail } from "./normalize.js";
import { findEligibility } from "./eligibility.js";
import { findStripeCustomers } from "./stripe.js";


function result(statusCode, body) {
  return { statusCode, body: { ...body, actionTaken: false } };
}

// Shared read-only verification; never writes to Stripe or Freshdesk.
export async function verifyChubby1(body = {}) {
  const ticketId = body.ticket_id ?? null;
  const email = normalizeEmail(body.email || "");
  const combinedText = [body.subject, body.message].filter(Boolean).join("\n");
  const phones = extractPhones(combinedText);

  if (!ticketId || (!email && phones.length === 0)) {
    return result(400, {
      ok: false,
      status: "manual_review",
      reason: "missing_ticket_or_customer_identifier"
    });
  }

  let eligibility;
  try {
    eligibility = findEligibility({ email, phones });
  } catch (error) {
    return result(500, {
      ok: false,
      status: "manual_review",
      reason: "eligibility_configuration_error"
    });
  }

  if (!eligibility.matched) {
    return result(200, {
      ok: true,
      ticketId,
      status: "not_eligible",
      matchedBy: null,
      stripeCustomers: []
    });
  }

  let stripeCustomers = [];
  try {
    stripeCustomers = await findStripeCustomers({ email, phones });
  } catch (error) {
    return result(200, {
      ok: true,
      ticketId,
      status: "manual_review",
      matchedBy: eligibility.matchedBy,
      reason: "stripe_lookup_failed",
      stripeCustomers: []
    });
  }

  if (stripeCustomers.length !== 1) {
    return result(200, {
      ok: true,
      ticketId,
      status: "manual_review",
      matchedBy: eligibility.matchedBy,
      reason: stripeCustomers.length === 0 ? "stripe_customer_not_found" : "multiple_stripe_customers",
      stripeCustomers
    });
  }

  return result(200, {
    ok: true,
    ticketId,
    status: "verified_read_only",
    matchedBy: eligibility.matchedBy,
    stripeCustomer: stripeCustomers[0],
    actionTaken: false
  });
}
