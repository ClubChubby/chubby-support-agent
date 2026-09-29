import { checkFreshdeskScope } from "./freshdesk-scope.js";
import { createHash } from "node:crypto";
import { stripeClient } from "./stripe.js";
import { previewChubby1, CHUBBY1_COUPON_ID } from "./coupon-preview.js";

export const APPLICATION_MARKER = "chubby1_202609_applied";
const MARKER_VALUE = "9MSuudHO:v1";
const outcome = (status, reason = null, actionTaken = false) => ({ status, reason, actionTaken });

// Activation is server-controlled. Missing/invalid configuration never writes.
// Pilot mode permits only explicitly selected Stripe customers, including AGENTTEST.
// Live mode excludes AGENTTEST so old synthetic tests cannot apply real discounts.
export function applicationEnabled(customerId, subject) {
  if (process.env.VERCEL_ENV !== "production") return false;
  if (process.env.CHUBBY1_APPLICATION_MODE === "pilot") {
    const ids = (process.env.CHUBBY1_PILOT_CUSTOMERS || "").split(",").map(s => s.trim());
    return /^cus_[A-Za-z0-9]+$/.test(customerId) && ids.includes(customerId);
  }
  return process.env.CHUBBY1_APPLICATION_MODE === "live" &&
    !/AGENTTEST/i.test(String(subject || ""));
}

function isCampaignDiscount(discount) {
  if (!discount || typeof discount !== "object" || !discount.coupon) {
    throw new Error("unexpanded_discount");
  }
  return (typeof discount.coupon === "string" ? discount.coupon : discount.coupon.id) === CHUBBY1_COUPON_ID;
}

async function allPages(list, params) {
  const rows = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await list({ ...params, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(page?.data) || typeof page.has_more !== "boolean") throw new Error("invalid_page");
    rows.push(...page.data);
    if (!page.has_more) return rows;
    const next = page.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error("incomplete_scan");
    cursor = next;
  }
  throw new Error("incomplete_scan");
}

// A coupon attachment alone is not redemption. Only completed invoices block
// reuse; incomplete or unresolved historical evidence always requires review.
async function redemptionHistory(stripe, customerId) {
  const subscriptions = await allPages(p => stripe.subscriptions.list(p), {
    customer: customerId, status: "all", expand: ["data.discounts", "data.items.data.discounts"]
  });
  const campaignSubscriptions = new Set();
  for (const sub of subscriptions) {
    if (sub.items?.has_more) throw new Error("incomplete_items");
    const discounts = [sub.discount, ...(sub.discounts || []),
      ...(sub.items?.data || []).flatMap(item => item.discounts || [])].filter(Boolean);
    if (discounts.some(isCampaignDiscount)) {
      if (!sub.id) throw new Error("missing_subscription_id");
      campaignSubscriptions.add(sub.id);
    }
  }
  const invoices = await allPages(p => stripe.invoices.list(p), {
    customer: customerId, expand: ["data.discounts", "data.total_discount_amounts.discount", "data.payment_intent"]
  });
  let unpaidAttempt = false;
  const evidencedSubscriptions = new Set();
  for (const invoice of invoices) {
    const discounts = [...(invoice.discounts || []),
      ...(invoice.total_discount_amounts || []).map(d => d.discount)].filter(Boolean);
    let campaign = discounts.some(isCampaignDiscount);
    const known = new Set(discounts.map(d => d.id));
    if (invoice.lines?.has_more) throw new Error("incomplete_invoice_lines");
    for (const line of invoice.lines?.data || []) {
      for (const d of [...(line.discounts || []), ...(line.discount_amounts || []).map(a => a.discount)]) {
        if (typeof d === "string") {
          if (!known.has(d)) throw new Error("unresolved_line_discount");
        } else if (isCampaignDiscount(d)) campaign = true;
      }
    }
    if (!campaign) continue;
    if (invoice.status === "paid" || invoice.paid === true || invoice.status_transitions?.paid_at) {
      return { redeemed: true, unpaidAttempt };
    }
    if (!["draft", "open", "void"].includes(invoice.status) || invoice.paid !== false ||
        invoice.amount_paid !== 0 || !Object.hasOwn(invoice, "payment_intent")) {
      throw new Error("uncertain_payment_history");
    }
    const payment = invoice.payment_intent;
    if (payment !== null && (typeof payment !== "object" ||
        !["canceled", "requires_payment_method", "requires_confirmation", "requires_action"].includes(payment.status))) {
      throw new Error("payment_unresolved_or_in_progress");
    }
    unpaidAttempt = true;
    const subscription = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
    if (subscription) evidencedSubscriptions.add(subscription);
  }
  if ([...campaignSubscriptions].some(id => !evidencedSubscriptions.has(id))) {
    throw new Error("subscription_redemption_unresolved");
  }
  return { redeemed: false, unpaidAttempt };
}

function applicationGeneration(customer) {
  const marker = customer?.metadata?.[APPLICATION_MARKER];
  if (!marker) return 0;
  if (marker === MARKER_VALUE) return 1;
  const match = /^9MSuudHO:v2:([1-9]\d*)$/.exec(marker);
  const generation = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(generation) && generation < 1000000 ? generation : null;
}

function hasCampaignCoupon(customer) {
  return customer?.discount?.coupon?.id === CHUBBY1_COUPON_ID;
}

// The only Stripe mutation in the service. Its destination must come from the
// allowlist verifier, never directly from ticket payloads. No invoices/subscriptions
// are created or changed; the member completes checkout in the existing app.
export async function applyChubby1(customerId, subject, ticketContext) {
  if (!applicationEnabled(customerId, subject)) return outcome("manual_review", "application_disabled");
  const stripe = stripeClient();
  let customer, generation, markerValue;
  try {
    customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || customer.id !== customerId || customer.livemode !== true) {
      return outcome("manual_review", "stripe_customer_unavailable");
    }
    generation = applicationGeneration(customer);
    if (generation === null) return outcome("manual_review", "application_marker_conflict");
    if (generation && hasCampaignCoupon(customer)) return outcome("already_applied", "campaign_already_applied");
    const history = await redemptionHistory(stripe, customerId);
    if (history.redeemed) return outcome("manual_review", "coupon_previously_used");
    if (generation && !history.unpaidAttempt) throw new Error("prior_application_unresolved");
    markerValue = generation ? `9MSuudHO:v2:${generation + 1}` : MARKER_VALUE;
  } catch {
    return outcome("manual_review", "redemption_history_unavailable");
  }

  // Repeat current eligibility checks immediately before the write. Long history
  // scans must not leave us relying on an old subscription/discount snapshot.
  const check = await previewChubby1(customerId, { forApplication: true });
  if (!check.preview.eligible) return outcome(check.status, check.reason);
  if (!applicationEnabled(customerId, subject)) return outcome("manual_review", "application_disabled");

  if (!ticketContext?.ticketId || !ticketContext?.revision) return outcome("manual_review", "freshdesk_context_missing");
  const scope = await checkFreshdeskScope(ticketContext.ticketId, ticketContext.revision, { requireOpen: ticketContext.requireOpen === true, requestDelayMs: ticketContext.requestDelayMs || 0 });
  if (!scope.allowed) return outcome(scope.status, scope.reason);
  if (scope.body.subject !== subject) return outcome("manual_review", "freshdesk_ticket_changed");

  if (ticketContext.expiresAt && Date.now() >= ticketContext.expiresAt) return outcome("manual_review", "backfill_expired_or_disabled");

  // A verified unpaid retry gets a new generation, while concurrent requests
  // for that generation share one key. Coupon and marker are written together.
  const idempotencyKey = (generation ? `chubby1-202609-v2-${generation + 1}-` : "chubby1-202609-v1-") +
    createHash("sha256").update(customerId).digest("hex");
  try {
    const updated = await stripe.customers.update(customerId, {
      coupon: CHUBBY1_COUPON_ID, metadata: { [APPLICATION_MARKER]: markerValue }
    }, { idempotencyKey });
    if (updated.id === customerId && updated.metadata?.[APPLICATION_MARKER] === markerValue &&
        updated.discount?.coupon?.id === CHUBBY1_COUPON_ID) {
      return outcome("coupon_applied", null, true);
    }
  } catch { /* Never report success from an uncertain Stripe write. */ }
  try {
    const current = await stripe.customers.retrieve(customerId);
    if (current.id === customerId && current.metadata?.[APPLICATION_MARKER] === markerValue && hasCampaignCoupon(current)) {
      return outcome("coupon_applied", "application_confirmed_after_retry", true);
    }
  } catch { /* Unknown outcome remains visible for human reconciliation. */ }
  return outcome("manual_review", "application_outcome_unknown", null);
}
