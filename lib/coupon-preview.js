import { stripeClient } from "./stripe.js";

export const CHUBBY1_COUPON_ID = "9MSuudHO";
export const CHUBBY1_PRODUCT_ID = "prod_RE0j1f8IisV0EI";

function hasDiscount(value) {
  return Boolean(value?.discount) || (Array.isArray(value?.discounts) && value.discounts.length > 0);
}

// This is a qualification preview, not a write plan or redemption guarantee.
export async function previewChubby1(customerId, { forApplication = false } = {}) {
  const stripe = stripeClient();
  const base = { mode: "read_only", couponId: CHUBBY1_COUPON_ID, customerId,
    amountOff: 8700, currency: "usd", actionTaken: false };
  const outcome = (status, reason, details = {}) => ({
    status, reason, preview: { ...base, ...details, eligible: status === "preview_ready_read_only" }
  });
  let customer, coupon;
  const subscriptions = [];
  try {
    [customer, coupon] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.coupons.retrieve(CHUBBY1_COUPON_ID, { expand: ["applies_to"] })
    ]);
    let cursor;
    // Bound work; an incomplete scan is always manual review.
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await stripe.subscriptions.list({
        customer: customerId, status: "all", limit: 100,
        ...(cursor ? { starting_after: cursor } : {})
      });
      subscriptions.push(...page.data);
      if (!page.has_more) break;
      const next = page.data.at(-1)?.id;
      if (!next || next === cursor || pageNumber === 99) {
        return outcome("manual_review", "subscription_scan_incomplete");
      }
      cursor = next;
    }
  } catch {
    return outcome("manual_review", "stripe_preview_lookup_failed");
  }

  if (customer.deleted || customer.id !== customerId) {
    return outcome("manual_review", "stripe_customer_unavailable");
  }
  const details = {
    subscriptionStatuses: [...new Set(subscriptions.map(s => s.status))],
    couponDuration: coupon.duration ?? null
  };
  if (subscriptions.some(s => s.status === "active")) {
    return outcome("not_eligible", "active_subscription", details);
  }
  // Historical canceled/expired subscriptions do not have current discounts.
  const current = subscriptions.filter(s => !["canceled", "incomplete_expired"].includes(s.status));
  if (hasDiscount(customer) || current.some(s =>
    hasDiscount(s) || s.items?.data?.some(hasDiscount))) {
    return outcome("manual_review", "existing_discount", details);
  }
  if (current.some(s => s.items?.has_more)) {
    return outcome("manual_review", "subscription_items_incomplete", details);
  }
  if (subscriptions.some(s => !["past_due", "canceled", "incomplete_expired"].includes(s.status))) {
    return outcome("manual_review", "subscription_status_requires_review", details);
  }
  if (coupon.id !== CHUBBY1_COUPON_ID || coupon.deleted || coupon.valid !== true) {
    return outcome("manual_review", "coupon_unavailable", details);
  }
  if (coupon.amount_off !== 8700 || coupon.currency !== "usd" || coupon.percent_off != null) {
    return outcome("manual_review", "coupon_value_mismatch", details);
  }
  const products = coupon.applies_to?.products || [];
  if (products.some(id => id !== CHUBBY1_PRODUCT_ID) ||
      (forApplication && (products.length !== 1 || coupon.duration !== "once" ||
        coupon.livemode !== true || customer.livemode !== true))) {
    return outcome("manual_review", "coupon_product_restriction", details);
  }
  return outcome("preview_ready_read_only", null, {
    ...details,
    applicationMethod: "customer_coupon",
    redemptionHistoryChecked: false
  });
}
