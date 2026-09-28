import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(s, context, next) {
    if (s === "stripe") return { url: "mock:live-stripe", shortCircuit: true };
    return next(s, context);
  },
  load(url, context, next) {
    if (url === "mock:live-stripe") return { format: "module", shortCircuit: true, source: `
      export default class Stripe {
        constructor(key, options) { globalThis.apiOptions = options; }
        customers = {
          retrieve: async () => structuredClone(globalThis.customer),
          update: async (id, params, options) => {
            globalThis.attempts.push({ id, params, options });
            if (globalThis.writeFailure === 'before') throw new Error('timeout');
            if (!globalThis.keys.has(options.idempotencyKey)) {
              globalThis.keys.add(options.idempotencyKey);
              globalThis.mutations++;
              globalThis.customer.metadata = { ...globalThis.customer.metadata, ...params.metadata };
              globalThis.customer.discount = { coupon: { id: params.coupon } };
            }
            if (globalThis.writeFailure === 'after') throw new Error('timeout');
            return structuredClone(globalThis.customer);
          }
        };
        coupons = { retrieve: async (id, params) => {
          globalThis.couponParams = params;
          return globalThis.coupon;
        }};
        subscriptions = { list: async params => {
          if (!params.expand && globalThis.lateActive) return { data: [{ status: 'active' }], has_more: false };
          return globalThis.subs;
        }};
        invoices = { list: async params => {
          if (globalThis.historyFailure) throw new Error('unavailable');
          return globalThis.invoicePages[params.starting_after ? 1 : 0];
        }};
      }
    ` };
    return next(url, context);
  }
});
const { applyChubby1, applicationEnabled, APPLICATION_MARKER } = await import("../lib/coupon-application.js");

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_mock_only";
  process.env.VERCEL_ENV = "production";
  process.env.CHUBBY1_APPLICATION_MODE = "pilot";
  process.env.CHUBBY1_PILOT_CUSTOMERS = "cus_fixture";
  globalThis.customer = { id: "cus_fixture", livemode: true, metadata: { keep: "unchanged" }, discount: null };
  globalThis.coupon = { id: "9MSuudHO", livemode: true, valid: true, currency: "usd", amount_off: 8700,
    percent_off: null, duration: "once", applies_to: { products: ["prod_RE0j1f8IisV0EI"] } };
  globalThis.subs = { data: [], has_more: false };
  globalThis.invoicePages = [{ data: [], has_more: false }];
  globalThis.attempts = [];
  globalThis.keys = new Set();
  globalThis.mutations = 0;
  globalThis.writeFailure = null;
  globalThis.historyFailure = false;
  globalThis.lateActive = false;
});
const run = () => applyChubby1("cus_fixture", "AGENTTEST");
const discount = () => ({ id: "di_prior", coupon: { id: "9MSuudHO" } });

test("disabled, preview environments, missing pilot IDs and synthetic live tickets never write", async () => {
  for (const mode of [undefined, "", "true", "LIVE", "live"]) {
    process.env.CHUBBY1_APPLICATION_MODE = mode;
    assert.equal((await run()).reason, "application_disabled");
  }
  process.env.CHUBBY1_APPLICATION_MODE = "pilot";
  process.env.VERCEL_ENV = "preview";
  assert.equal((await run()).reason, "application_disabled");
  process.env.VERCEL_ENV = "production";
  process.env.CHUBBY1_PILOT_CUSTOMERS = "cus_different";
  assert.equal((await run()).reason, "application_disabled");
  assert.equal(attempts.length, 0);
  process.env.CHUBBY1_APPLICATION_MODE = "live";
  assert.equal(applicationEnabled("cus_fixture", "CHUBBY1 help"), true);
});
test("one customer update atomically attaches coupon and permanent marker; unrelated metadata survives", async () => {
  assert.equal((await run()).status, "coupon_applied");
  assert.equal(mutations, 1);
  assert.deepEqual(attempts[0].params, { coupon: "9MSuudHO", metadata: { [APPLICATION_MARKER]: "9MSuudHO:v1" } });
  assert.equal(customer.metadata.keep, "unchanged");
  assert.deepEqual(couponParams, { expand: ["applies_to"] });
  assert.equal(apiOptions.apiVersion, "2024-06-20");
});
test("consumed discount and expired Stripe idempotency cache cannot trigger a second application", async () => {
  await run();
  customer.discount = null;
  keys.clear();
  const retry = await run();
  assert.equal(retry.status, "already_applied");
  assert.equal(retry.actionTaken, false);
  assert.equal(mutations, 1);
});
test("concurrent tickets use identical idempotency key and parameters", async () => {
  const results = await Promise.all([run(), run()]);
  assert.equal(mutations, 1);
  assert.ok(results.every(r => ["coupon_applied", "manual_review", "already_applied"].includes(r.status)));
  assert.equal(new Set(attempts.map(a => a.options.idempotencyKey)).size, 1);
});
test("timeout after Stripe writes is reconciled from permanent marker", async () => {
  writeFailure = "after";
  const r = await run();
  assert.equal(r.status, "coupon_applied");
  assert.equal(r.reason, "application_confirmed_after_retry");
  assert.equal(mutations, 1);
});
test("uncertain writes report unknown action instead of a false success or rejection", async () => {
  writeFailure = "before";
  const r = await run();
  assert.equal(r.reason, "application_outcome_unknown");
  assert.equal(r.actionTaken, null);
});
test("a subscription activated during history checks blocks the write", async () => {
  lateActive = true;
  assert.equal((await run()).reason, "active_subscription");
  assert.equal(attempts.length, 0);
});
test("past due is allowed, but customer/subscription/item discounts are not overwritten", async () => {
  subs.data = [{ status: "past_due" }];
  assert.equal((await run()).status, "coupon_applied");
});
test("existing customer discount blocks application", async () => {
  customer.discount = { coupon: { id: "another_coupon" } };
  assert.equal((await run()).reason, "existing_discount");
  assert.equal(attempts.length, 0);
});
test("current subscription discount blocks application", async () => {
  subs.data = [{ status: "past_due", discounts: [{ id: "di_other", coupon: { id: "another" } }] }];
  assert.equal((await run()).reason, "existing_discount");
  assert.equal(attempts.length, 0);
});
test("prior coupon on historical subscription blocks repeat redemption", async () => {
  subs.data = [{ status: "canceled", discount: discount() }];
  assert.equal((await run()).reason, "coupon_previously_used");
  assert.equal(attempts.length, 0);
});
test("prior coupon on a later invoice page blocks application", async () => {
  invoicePages = [{ data: [{ id: "in_first" }], has_more: true },
    { data: [{ id: "in_second", discounts: [discount()] }], has_more: false }];
  assert.equal((await run()).reason, "coupon_previously_used");
  assert.equal(attempts.length, 0);
});
test("unavailable, incomplete and unexpanded historical reads fail closed", async () => {
  historyFailure = true;
  assert.equal((await run()).reason, "redemption_history_unavailable");
  historyFailure = false;
  for (const invoice of [{ discounts: ["di_unexpanded"] }, { lines: { has_more: true } },
    { lines: { data: [{ discounts: ["di_unresolved"] }] } }]) {
    invoicePages = [{ data: [invoice], has_more: false }];
    assert.equal((await run()).reason, "redemption_history_unavailable");
  }
  assert.equal(attempts.length, 0);
});
test("live-mode, product, duration and amount are checked before any write", async () => {
  const original = structuredClone(coupon);
  for (const patch of [{ livemode: false }, { duration: "forever" }, { amount_off: 1 },
    { applies_to: {} }, { applies_to: { products: ["prod_wrong"] } }]) {
    coupon = { ...original, ...patch };
    assert.equal((await run()).status, "manual_review");
  }
  assert.equal(attempts.length, 0);
});
test("conflicting marker fails closed", async () => {
  customer.metadata[APPLICATION_MARKER] = "unknown";
  assert.equal((await run()).reason, "application_marker_conflict");
  assert.equal(attempts.length, 0);
});
