import { extractPhones, normalizeEmail } from "../../lib/normalize.js";
import { findEligibility } from "../../lib/eligibility.js";
import { findStripeCustomers } from "../../lib/stripe.js";

function json(res, status, body) {
  res.status(status).setHeader("content-type", "application/json");
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret) {
    return json(res, 500, { ok: false, error: "server_not_configured" });
  }

  const suppliedSecret = req.headers["x-chubby-webhook-secret"];
  if (suppliedSecret !== expectedSecret) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  const body = req.body || {};
  const ticketId = body.ticket_id ?? null;
  const email = normalizeEmail(body.email || "");
  const combinedText = [body.subject, body.message].filter(Boolean).join("\n");
  const phones = extractPhones(combinedText);

  if (!ticketId || (!email && phones.length === 0)) {
    return json(res, 400, {
      ok: false,
      status: "manual_review",
      reason: "missing_ticket_or_customer_identifier"
    });
  }

  let eligibility;
  try {
    eligibility = findEligibility({ email, phones });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      status: "manual_review",
      reason: "eligibility_configuration_error"
    });
  }

  if (!eligibility.matched) {
    return json(res, 200, {
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
    return json(res, 200, {
      ok: true,
      ticketId,
      status: "manual_review",
      matchedBy: eligibility.matchedBy,
      reason: "stripe_lookup_failed",
      stripeCustomers: []
    });
  }

  if (stripeCustomers.length !== 1) {
    return json(res, 200, {
      ok: true,
      ticketId,
      status: "manual_review",
      matchedBy: eligibility.matchedBy,
      reason: stripeCustomers.length === 0 ? "stripe_customer_not_found" : "multiple_stripe_customers",
      stripeCustomers
    });
  }

  return json(res, 200, {
    ok: true,
    ticketId,
    status: "verified_read_only",
    matchedBy: eligibility.matchedBy,
    stripeCustomer: stripeCustomers[0],
    actionTaken: false
  });
}
