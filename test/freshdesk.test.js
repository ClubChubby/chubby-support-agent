import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Mock only the Stripe SDK boundary; exercise the real routes and shared logic.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/approved-list.js")) return { url: "mock:allowlist", shortCircuit: true };
    if (specifier === "stripe") return { url: "mock:stripe", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:allowlist") return { format: "module", shortCircuit: true,
      source: 'export function loadApprovedRecords() { const rows = JSON.parse(process.env.CHUBBY1_ELIGIBILITY_JSON); if (!Array.isArray(rows)) throw new Error("invalid"); return rows; }' };
    if (url === "mock:stripe") return {
      format: "module", shortCircuit: true,
      source: `export default class Stripe {
        customers = { list: async (params) => {
          globalThis.stripeCalls.push(params);
          if (globalThis.stripeError) throw new Error("lookup failed");
          return { data: globalThis.stripeData };
        }, retrieve: async (id) => {
          globalThis.stripeCalls.push({ retrieve: id });
          if (globalThis.stripeError) throw Object.assign(new Error("lookup failed"), { code: globalThis.stripeError });
          return globalThis.stripeData[0];
        }, update: async (id, params) => {
          globalThis.writeCalls.push({ id, params });
          return { ...globalThis.stripeData[0], metadata: params.metadata, discount: { coupon: { id: params.coupon } } };
        }};
        invoices = { list: async () => ({ data: [], has_more: false }) };

        coupons = { retrieve: async (id) => {
          globalThis.previewCalls.push({ coupon: id });
          if (globalThis.previewError) throw new Error("preview failed");
          return globalThis.testCoupon;
        }};
        subscriptions = { list: async (params) => {
          globalThis.previewCalls.push({ subscriptions: params });
          return globalThis.subscriptionPages[params.starting_after ? 1 : 0];
        }};
      }`
    };
    return next(url, context);
  }
});
const { default: intake } = await import("../api/freshdesk/intake.js");
const { default: direct } = await import("../api/freshdesk/chubby1.js");
beforeEach(() => {
  process.env.FRESHDESK_API_KEY = "fixture-only";
  process.env.FRESHDESK_CODY_AGENT_ID = "42";
  globalThis.scopeCalls = 0;
  globalThis.ticketOverride = null;
  globalThis.conversations = [];
  globalThis.fetch = async (url) => {
    scopeCalls++;
    if (url.includes("/conversations?")) return { ok: true, json: async () => conversations };
    const b = globalThis.apiBody;
    return { ok: true, json: async () => ({ id: Number(b.ticket_id), responder_id: 42,
      created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-28T00:00:00Z", subject: b.subject || "", description_text: b.message || "",
      requester: { email: b.email || "" }, ...globalThis.ticketOverride }) };
  };
  delete process.env.CHUBBY1_APPLICATION_MODE;
  delete process.env.CHUBBY1_PILOT_CUSTOMERS;
  delete process.env.CHUBBY1_PILOT_TEST_ACCOUNT;
  process.env.WEBHOOK_SECRET = "test-secret";
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([{ email: "member@example.com", phone: "6265551234", eligible: true }]);
  globalThis.stripeCalls = [];
  globalThis.writeCalls = [];
  globalThis.stripeData = [{ id: "cus_fixture", email: "member@example.com", phone: "+1 626 555 1234" }];
  globalThis.stripeError = false;
  globalThis.previewCalls = [];
  globalThis.previewError = false;
  globalThis.testCoupon = { id: "9MSuudHO", valid: true, amount_off: 8700, currency: "usd", percent_off: null, duration: "once" };
  globalThis.subscriptionPages = [{ data: [], has_more: false }];
});
async function request(handler, overrides = {}) {
  const req = { method: "POST", headers: { "x-chubby-webhook-secret": "test-secret" },
    body: { ticket_id: "123", email: " MEMBER@example.com ", subject: "AGENTTEST", message: "CHUBBY1 promotion. Phone: 626-555-1234" }, ...overrides };
  const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; }, send(s) { this.body = JSON.parse(s); } };
  globalThis.apiBody = req.body;
  await handler(req, res);
  return res;
}
test("inferred comeback offer uses the same eligibility and Stripe verification", async () => {
  const body = { ticket_id: "123", email: "member@example.com", subject: "Membership offer",
    message: "A text offered my membership back for 1$ but the code failed." };
  const r = await request(intake, { body });
  assert.equal(r.body.classification.workflow, "chubby1");
  assert.equal(r.body.status, "preview_ready_read_only");
  assert.equal(r.body.actionTaken, false);
  assert.equal(writeCalls.length, 0);
  process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
  stripeCalls.length = 0;
  const denied = await request(intake, { body });
  assert.equal(denied.body.status, "not_eligible");
  assert.equal(stripeCalls.length, 0);
  assert.equal(writeCalls.length, 0);
});

test("PLUS purchase screening still requires an approved record and checks subscriptions", async () => {
  const body = { ticket_id: "123", email: "member@example.com", subject: "PLUS purchase",
    message: "I want to purchase PLUS for $1" };
  let r = await request(intake, { body });
  assert.equal(r.body.classification.workflow, "chubby1");
  assert.equal(r.body.status, "preview_ready_read_only");
  subscriptionPages = [{ data: [{ id: "sub_active", status: "active" }], has_more: false }];
  r = await request(intake, { body });
  assert.equal(r.body.reason, "active_subscription");
  process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
  r = await request(intake, { body });
  assert.equal(r.body.status, "not_eligible");
  assert.equal(writeCalls.length, 0);
});

for (const [name, handler] of [["intake", intake], ["direct", direct]]) {
  test(name + ": verified and read-only", async () => {
    const r = await request(handler);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.status, "preview_ready_read_only");
    assert.equal(r.body.actionTaken, false);
    assert.equal(r.body.stripeCustomer.phoneMatch, true);
    assert.deepEqual(stripeCalls, [{ email: "member@example.com", limit: 10 }, { retrieve: "cus_fixture" }]);
    if (name === "intake") assert.equal(r.body.classification.workflow, "chubby1");
  });
  test(name + ": authentication and method guards prevent lookups", async () => {
    assert.equal((await request(handler, { method: "GET" })).statusCode, 405);
    assert.equal((await request(handler, { headers: {} })).statusCode, 401);
    delete process.env.WEBHOOK_SECRET;
    assert.equal((await request(handler)).statusCode, 500);
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": missing identifiers", async () => {
    const r = await request(handler, { body: { ticket_id: "123", message: "CHUBBY1" } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.status, "manual_review");
    assert.equal((await request(handler, { body: {} })).statusCode, 400);
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": ineligible does not query Stripe", async () => {
    process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
    const r = await request(handler);
    assert.equal(r.body.status, "not_eligible");
    assert.equal(r.body.actionTaken, false);
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": invalid eligibility fails closed", async () => {
    for (const value of ["invalid", "{}"]) {
      process.env.CHUBBY1_ELIGIBILITY_JSON = value;
      const r = await request(handler);
      assert.equal(r.statusCode, 500);
      assert.equal(r.body.reason, "eligibility_configuration_error");
    }
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": ambiguous and failed Stripe lookups require review", async () => {
    for (const [data, reason] of [[[], "stripe_customer_not_found"], [[{id:"a"}, {id:"b"}], "multiple_stripe_customers"]]) {
      globalThis.stripeData = data;
      const r = await request(handler);
      assert.equal(r.body.status, "manual_review");
      assert.equal(r.body.reason, reason);
      assert.equal(r.body.actionTaken, false);
    }
    globalThis.stripeError = true;
    assert.equal((await request(handler)).body.reason, "stripe_lookup_failed");
    globalThis.stripeError = false;
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal((await request(handler)).body.reason, "stripe_lookup_failed");
  });
  test(name + ": phone-only ticket resolves the approved record email", async () => {
    const r = await request(handler, { body: { ticket_id: "123", message: "CHUBBY1 626-555-1234" } });
    assert.equal(r.body.matchedBy, "phone");
    assert.equal(r.body.status, "preview_ready_read_only");
    assert.deepEqual(stripeCalls, [{ email: "member@example.com", limit: 10 }, { retrieve: "cus_fixture" }]);
  });
  test(name + ": another sender can name an approved account", async () => {
    for (const message of ["Chubby 1 <MEMBER@EXAMPLE.COM>.", "CHUBBY1 626-555-1234"]) {
      globalThis.stripeCalls = [];
  globalThis.writeCalls = [];
      const r = await request(handler, { body: { ticket_id: "123", email: "sender@example.com", message, stripeCustomerId: "cus_untrusted" } });
      assert.equal(r.body.status, "preview_ready_read_only");
      assert.equal(r.body.stripeCustomer.id, "cus_fixture");
      assert.deepEqual(stripeCalls, [{ email: "member@example.com", limit: 10 }, { retrieve: "cus_fixture" }]);
    }
  });
  test(name + ": email in subject works without a requester email", async () => {
    const r = await request(handler, { body: { ticket_id: "123", subject: "Chubby 1 MEMBER@EXAMPLE.COM", message: "" } });
    assert.equal(r.body.status, "preview_ready_read_only");
  });
  test(name + ": conflicting approved records never query Stripe", async () => {
    process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([
      { email: "member@example.com", phone: "6265551234", eligible: true },
      { email: "other@example.com", phone: "2125551234", eligible: true }
    ]);
    for (const message of ["CHUBBY1 other@example.com", "CHUBBY1 212-555-1234"]) {
      const r = await request(handler, { body: { ticket_id: "123", email: "member@example.com", message } });
      assert.equal(r.body.reason, "multiple_eligible_records");
      assert.equal(r.body.actionTaken, false);
    }
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": approved ID takes priority without falling back to sender or email", async () => {
    process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([{ email: "member@example.com", stripeCustomerId: "cus_approved", eligible: true }]);
    globalThis.stripeData = [{ id: "cus_approved", email: "changed@example.com" }];
    assert.equal((await request(handler)).body.stripeCustomer.id, "cus_approved");
    assert.deepEqual(stripeCalls, [{ retrieve: "cus_approved" }, { retrieve: "cus_approved" }]);
    globalThis.stripeData = [{ id: "cus_approved", deleted: true }];
    assert.equal((await request(handler)).body.reason, "stripe_customer_not_found");
    globalThis.stripeError = "resource_missing";
    assert.equal((await request(handler)).body.reason, "stripe_customer_not_found");
    globalThis.stripeError = "api_error";
    assert.equal((await request(handler)).body.reason, "stripe_lookup_failed");
    assert.ok(stripeCalls.every(call => call.retrieve === "cus_approved"));
  });
  test(name + ": phone record may resolve by approved ID without an email", async () => {
    process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([{ phone: "6265551234", stripeCustomerId: "cus_fixture", eligible: true }]);
    assert.equal((await request(handler)).body.status, "preview_ready_read_only");
    assert.deepEqual(stripeCalls, [{ retrieve: "cus_fixture" }, { retrieve: "cus_fixture" }]);
  });
  test(name + ": incomplete or malformed approved destination requires review", async () => {
    for (const [row, reason] of [
      [{ phone: "6265551234", eligible: true }, "approved_account_identifier_missing"],
      [{ phone: "6265551234", eligible: true, stripeCustomerId: "invalid" }, "invalid_approved_stripe_customer_id"]
    ]) {
      process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([row]);
      assert.equal((await request(handler)).body.reason, reason);
    }
    assert.equal(stripeCalls.length, 0);
  });
  test(name + ": disabled records cannot qualify", async () => {
    process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([{ email: "member@example.com", eligible: false }]);
    assert.equal((await request(handler)).body.status, "not_eligible");
    assert.equal(stripeCalls.length, 0);
  });

  test(name + ": active blocks even if canceling at period end", async () => {
    globalThis.subscriptionPages = [{ data: [{ id: "sub_active", status: "active", cancel_at_period_end: true }], has_more: false }];
    const r = await request(handler);
    assert.equal(r.body.status, "not_eligible");
    assert.equal(r.body.reason, "active_subscription");
    assert.equal(r.body.actionTaken, false);
  });
  test(name + ": past due allowed; trialing and unspecified states require review", async () => {
    for (const status of ["past_due", "trialing", "paused", "unpaid", "incomplete"]) {
      globalThis.subscriptionPages = [{ data: [{ id: "sub_test", status }], has_more: false }];
      const r = await request(handler);
      assert.equal(r.body.status, status === "past_due" ? "preview_ready_read_only" : "manual_review");
    }
  });
  test(name + ": customer, subscription and item discounts require review", async () => {
    globalThis.stripeData[0].discount = { id: "di_existing" };
    assert.equal((await request(handler)).body.reason, "existing_discount");
    delete globalThis.stripeData[0].discount;
    for (const extra of [{ discounts: ["di_existing"] }, { items: { data: [{ discounts: ["di_existing"] }] } }]) {
      globalThis.subscriptionPages = [{ data: [{ id: "sub_test", status: "past_due", ...extra }], has_more: false }];
      assert.equal((await request(handler)).body.reason, "existing_discount");
    }
  });
  test(name + ": validates coupon value, validity and product limits", async () => {
    for (const [extra, reason] of [
      [{ amount_off: 8600 }, "coupon_value_mismatch"],
      [{ currency: "cad" }, "coupon_value_mismatch"],
      [{ percent_off: 50 }, "coupon_value_mismatch"],
      [{ valid: false }, "coupon_unavailable"],
      [{ applies_to: { products: ["prod_limited"] } }, "coupon_product_restriction"]
    ]) {
      const saved = globalThis.testCoupon;
      globalThis.testCoupon = { ...saved, ...extra };
      assert.equal((await request(handler)).body.reason, reason);
      globalThis.testCoupon = saved;
    }
    globalThis.previewError = true;
    assert.equal((await request(handler)).body.reason, "stripe_preview_lookup_failed");
  });
  test(name + ": checks later subscription pages and scopes reads to approved account", async () => {
    globalThis.subscriptionPages = [
      { data: [{ id: "sub_old", status: "canceled" }], has_more: true },
      { data: [{ id: "sub_active", status: "active" }], has_more: false }
    ];
    assert.equal((await request(handler)).body.reason, "active_subscription");
    assert.deepEqual(previewCalls.filter(c => c.subscriptions).map(c => c.subscriptions), [
      { customer: "cus_fixture", status: "all", limit: 100 },
      { customer: "cus_fixture", status: "all", limit: 100, starting_after: "sub_old" }
    ]);
  });
  test(name + ": repeated preview has no side effects and does not claim redemption checks", async () => {
    const first = await request(handler);
    const second = await request(handler);
    assert.deepEqual(first.body, second.body);
    assert.equal(first.body.preview.couponId, "9MSuudHO");
    assert.equal(first.body.preview.redemptionHistoryChecked, false);
    assert.equal(first.body.preview.applicationMethod, "customer_coupon");
    assert.equal(first.body.actionTaken, false);
  });

  test(name + ": incomplete subscription/item reads never qualify", async () => {
    globalThis.subscriptionPages = [{ data: [], has_more: true }];
    assert.equal((await request(handler)).body.reason, "subscription_scan_incomplete");
    globalThis.subscriptionPages = [{ data: [{ id: "sub_due", status: "past_due", items: { data: [], has_more: true } }], has_more: false }];
    assert.equal((await request(handler)).body.reason, "subscription_items_incomplete");
  });
  test(name + ": ended subscriptions and historical discounts do not disqualify", async () => {
    globalThis.subscriptionPages = [{ data: [
      { id: "sub_old", status: "canceled", discounts: ["di_historical"] },
      { id: "sub_expired", status: "incomplete_expired" }
    ], has_more: false }];
    const r = await request(handler);
    assert.equal(r.body.status, "preview_ready_read_only");
    assert.equal(r.body.preview.eligible, true);
  });

}
test("other workflows retain classification-only behavior", async () => {
  const r = await request(intake, { body: { ticket_id: "123", subject: "cancel membership" } });
  assert.equal(r.body.classification.workflow, "cancellation");
  assert.equal(r.body.nextStep, "workflow_not_implemented_yet");
  assert.equal(r.body.actionTaken, false);
  assert.equal(stripeCalls.length, 0);
});

function enablePilot() {
  process.env.VERCEL_ENV = "production";
  process.env.CHUBBY1_APPLICATION_MODE = "pilot";
  process.env.CHUBBY1_PILOT_CUSTOMERS = "cus_fixture";
  globalThis.stripeData[0].livemode = true;
  globalThis.testCoupon.livemode = true;
  globalThis.testCoupon.applies_to = { products: ["prod_RE0j1f8IisV0EI"] };
}
test("pilot intake applies only to the allowlist-selected account", async () => {
  enablePilot();
  const r = await request(intake, { body: { ticket_id: "321", email: "outsider@example.com",
    subject: "AGENTTEST", message: "Chubby 1 member@example.com", customerId: "cus_attacker" } });
  assert.equal(r.body.status, "coupon_applied");
  assert.equal(r.body.actionTaken, true);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].id, "cus_fixture");
});
test("pilot cannot bypass authentication, allowlist or ambiguity", async () => {
  enablePilot();
  await request(intake, { headers: {} });
  process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
  await request(intake);
  process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([
    { email: "member@example.com", eligible: true }, { phone: "6265551234", eligible: true }
  ]);
  await request(intake);
  assert.equal(writeCalls.length, 0);
});
test("direct verifier stays read-only even with live application enabled", async () => {
  enablePilot();
  const r = await request(direct);
  assert.equal(r.body.status, "preview_ready_read_only");
  assert.equal(writeCalls.length, 0);
});
test("live mode skips synthetic AGENTTEST tickets", async () => {
  enablePilot();
  process.env.CHUBBY1_APPLICATION_MODE = "live";
  const r = await request(intake);
  assert.equal(r.body.status, "preview_ready_read_only");
  assert.equal(writeCalls.length, 0);
});

function enableException() {
  enablePilot();
  process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
  process.env.CHUBBY1_PILOT_TEST_ACCOUNT = JSON.stringify({ email: "member@example.com", phone: "6265551234",
    stripeCustomerId: "cus_fixture", expiresAt: Date.now() + 3600000 });
}
test("explicit private pilot exception works with both identifiers and preserves the list", async () => {
  enableException();
  const r = await request(intake);
  assert.equal(r.body.status, "coupon_applied");
  assert.equal(r.body.matchedBy, "owner_authorized_pilot");
  assert.equal(process.env.CHUBBY1_ELIGIBILITY_JSON, "[]");
});
test("pilot exception cannot affect direct route, real tickets, live mode, or other accounts", async () => {
  enableException();
  assert.equal((await request(direct)).body.status, "not_eligible");
  assert.equal((await request(intake, { body: { ticket_id: "123", email: "member@example.com", subject: "CHUBBY1", message: "6265551234" } })).body.status, "not_eligible");
  assert.equal((await request(intake, { body: { ticket_id: "123", email: "member@example.com", subject: "AGENTTEST", message: "CHUBBY1" } })).body.status, "not_eligible");
  process.env.CHUBBY1_APPLICATION_MODE = "live";
  assert.equal((await request(intake)).body.status, "not_eligible");
  process.env.CHUBBY1_APPLICATION_MODE = "pilot";
  process.env.CHUBBY1_PILOT_CUSTOMERS = "cus_other";
  assert.equal((await request(intake)).body.status, "not_eligible");
  assert.equal(writeCalls.length, 0);
});
test("expired/malformed pilot exception fails closed and subscription guard still applies", async () => {
  enableException();
  const config = JSON.parse(process.env.CHUBBY1_PILOT_TEST_ACCOUNT);
  for (const value of ["invalid", JSON.stringify({ ...config, expiresAt: Date.now()-1 }),
    JSON.stringify({ ...config, expiresAt: Date.now()+172800000 })]) {
    process.env.CHUBBY1_PILOT_TEST_ACCOUNT = value;
    assert.equal((await request(intake)).body.status, "not_eligible");
  }
  process.env.CHUBBY1_PILOT_TEST_ACCOUNT = JSON.stringify(config);
  globalThis.subscriptionPages = [{ data: [{ status: "active" }], has_more: false }];
  assert.equal((await request(intake)).body.reason, "active_subscription");
  assert.equal(writeCalls.length, 0);
});

for (const handler of [intake, direct]) {
  test(handler.name + ": other assignees are skipped before classification or Stripe reads", async () => {
    ticketOverride = { responder_id: 99 };
    const r = await request(handler);
    assert.equal(r.body.reason, "not_assigned_to_cody");
    assert.equal(scopeCalls, 1);
    assert.equal(stripeCalls.length, 0);
  });
  test(handler.name + ": Cody reply blocks all processing", async () => {
    conversations = [{ id: 10, ticket_id: 123, user_id: 42, source: 0, private: false, incoming: false }];
    const r = await request(handler);
    assert.equal(r.body.reason, "cody_already_replied");
    assert.equal(stripeCalls.length, 0);
  });
}
test("webhook text cannot override current ticket content", async () => {
  ticketOverride = { subject: "General question", description_text: "Opening hours?", requester: { email: "other@example.com" } };
  const r = await request(intake);
  assert.notEqual(r.body.classification.workflow, "chubby1");
  assert.equal(stripeCalls.length, 0);
});
test("late reply prevents coupon mutation", async () => {
  enablePilot();
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (scopeCalls >= 3) conversations = [{ id: 10, ticket_id: 123, user_id: 42, source: 0, private: false, incoming: false }];
    return original(url);
  };
  const r = await request(intake);
  assert.equal(r.body.reason, "cody_already_replied");
  assert.equal(writeCalls.length, 0);
});
test("late reassignment prevents coupon mutation", async () => {
  enablePilot();
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (scopeCalls >= 3) ticketOverride = { responder_id: 99 };
    return original(url);
  };
  const r = await request(intake);
  assert.equal(r.body.reason, "not_assigned_to_cody");
  assert.equal(writeCalls.length, 0);
});

test("verified batch account still requires list eligibility and subscription checks before applying", async () => {
  enablePilot();
  process.env.CHUBBY1_APPLICATION_MODE = "live";
  process.env.CHUBBY1_BACKFILL = JSON.stringify({ expiresAt: Date.now() + 60000, ticketIds: ["123"], accountMatches: [
    { ticketId: "123", email: "member@example.com", phone: "6265551234", customerId: "cus_fixture", userId: "fixtureUid" }
  ] });
  stripeData[0].email = null;
  stripeData[0].metadata = { uid: "fixtureUid" };
  subscriptionPages = [{ data: [{ id: "sub_active", status: "active" }], has_more: false }];
  let r = await request(intake, { body: { ticket_id: "123", email: "member@example.com", subject: "CHUBBY1 help", message: "6265551234" } });
  assert.equal(r.body.reason, "active_subscription");
  assert.equal(writeCalls.length, 0);
  process.env.CHUBBY1_ELIGIBILITY_JSON = "[]";
  r = await request(intake, { body: { ticket_id: "123", email: "member@example.com", subject: "CHUBBY1 help", message: "6265551234" } });
  assert.equal(r.body.status, "not_eligible");
  assert.equal(writeCalls.length, 0);
  process.env.CHUBBY1_ELIGIBILITY_JSON = JSON.stringify([{ email: "member@example.com", phone: "6265551234", eligible: true }]);
  subscriptionPages = [{ data: [], has_more: false }];
  r = await request(intake, { body: { ticket_id: "123", email: "member@example.com", subject: "CHUBBY1 help", message: "6265551234" } });
  assert.equal(r.body.status, "coupon_applied");
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].id, "cus_fixture");
  delete process.env.CHUBBY1_BACKFILL;
});

test("phone in requester follow-up qualifies even when sender email is absent from approved list", async () => {
  ticketOverride = { requester_id: 99 };
  conversations = [{ id: 10, ticket_id: 123, user_id: 99, source: 0, private: false, incoming: true,
    body_text: "My phone number is +1 (626) 555-1234" }];
  const r = await request(intake, { body: { ticket_id: "123", email: "different@example.com",
    subject: "Code did not work", message: "CHUBBY1 did not work" } });
  assert.equal(r.body.status, "preview_ready_read_only");
  assert.equal(r.body.matchedBy, "phone");
  assert.equal(writeCalls.length, 0);
});
