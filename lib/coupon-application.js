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

// Conservatively stop for any prior attachment of this coupon, including void
// invoices. Unknown/unexpanded history is manual review, never assumed unused.
async function previouslyApplied(stripe, customerId) {
  const subscriptions = await allPages(p => stripe.subscriptions.list(p), {
    customer: customerId, status: "all", expand: ["data.discounts", "data.items.data.discounts"]
  });
  for (const sub of subscriptions) {
    if (sub.items?.has_more) throw new Error("incomplete_items");
    const discounts = [sub.discount, ...(sub.discounts || []),
      ...(sub.items?.data || []).flatMap(item => item.discounts || [])].filter(Boolean);
    if (discounts.some(isCampaignDiscount)) return true;
  }
  const invoices = await allPages(p => stripe.invoices.list(p), {
    customer: customerId, expand: ["data.discounts", "data.total_discount_amounts.discount"]
  });
  for (const invoice of invoices) {
    const discounts = [...(invoice.discounts || []),
      ...(invoice.total_discount_amounts || []).map(d => d.discount)].filter(Boolean);
    if (discounts.some(isCampaignDiscount)) return true;
    // Every actual line discount must appear in expanded invoice totals. If it
    // cannot be resolved, require review instead of silently skipping it.
    const known = new Set(discounts.map(d => d.id));
    if (invoice.lines?.has_more) throw new Error("incomplete_invoice_lines");
    for (const line of invoice.lines?.data || []) {
      for (const d of [...(line.discounts || []), ...(line.discount_amounts || []).map(a => a.discount)]) {
        if (typeof d === "string") {
          if (!known.has(d)) throw new Error("unresolved_line_discount");
        } else if (isCampaignDiscount(d)) return true;
      }
    }
  }
  return false;
}

function appliedByAgent(customer) {
  return customer?.metadata?.[APPLICATION_MARKER] === MARKER_VALUE;
}

// The only Stripe mutation in the service. Its destination must come from the
// allowlist verifier, never directly from ticket payloads. No invoices/subscriptions
// are created or changed; the member completes checkout in the existing app.
export async function applyChubby1(customerId, subject, ticketContext) {
  if (!applicationEnabled(customerId, subject)) return outcome("manual_review", "application_disabled");
  const stripe = stripeClient();
  let customer;
  try {
    customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || customer.id !== customerId || customer.livemode !== true) {
      return outcome("manual_review", "stripe_customer_unavailable");
    }
    if (appliedByAgent(customer)) return outcome("already_applied", "campaign_already_applied");
    if (customer.metadata?.[APPLICATION_MARKER]) return outcome("manual_review", "application_marker_conflict");
    if (await previouslyApplied(stripe, customerId)) return outcome("manual_review", "coupon_previously_used");
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

  // Identical across tickets/retries. The permanent marker and coupon are written
  // in ONE Stripe update, so a timeout cannot lose a separately written ledger.
  // Stripe idempotency handles concurrent retries; the marker handles later days.
  const idempotencyKey = "chubby1-202609-v1-" + createHash("sha256").update(customerId).digest("hex");
  try {
    const updated = await stripe.customers.update(customerId, {
      coupon: CHUBBY1_COUPON_ID, metadata: { [APPLICATION_MARKER]: MARKER_VALUE }
    }, { idempotencyKey });
    if (updated.id === customerId && appliedByAgent(updated) &&
        updated.discount?.coupon?.id === CHUBBY1_COUPON_ID) {
      return outcome("coupon_applied", null, true);
    }
  } catch { /* Never report success from an uncertain Stripe write. */ }
  try {
    const current = await stripe.customers.retrieve(customerId);
    if (current.id === customerId && appliedByAgent(current)) {
      return outcome("coupon_applied", "application_confirmed_after_retry", true);
    }
  } catch { /* Unknown outcome remains visible for human reconciliation. */ }
  return outcome("manual_review", "application_outcome_unknown", null);
}
