import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkFreshdeskScope } from "../lib/freshdesk-scope.js";

let ticket, pages, requests, fail, lateTicket;
const conversation = (id, overrides = {}) => ({ id, ticket_id: 123, user_id: 99, source: 0, private: false, incoming: true, ...overrides });
beforeEach(() => {
  process.env.FRESHDESK_API_KEY = "fixture-not-a-secret";
  process.env.FRESHDESK_CODY_AGENT_ID = "42";
  ticket = { id: 123, responder_id: 42, subject: "Chubby 1", description_text: "member@example.com",
    updated_at: "2026-09-28T00:00:00Z", requester: { email: "sender@example.com" } };
  pages = [[]]; requests = []; fail = false; lateTicket = null;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (fail) throw new Error("private response body must not escape");
    if (url.includes("/conversations?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return { ok: true, json: async () => pages[page - 1] ?? [] };
    }
    return { ok: true, json: async () => structuredClone(requests.length > 1 && lateTicket ? lateTicket : ticket) };
  };
});
test("only current Cody tickets produce trusted input; fixed HTTPS origin and GET only", async () => {
  const r = await checkFreshdeskScope("123");
  assert.equal(r.allowed, true);
  assert.equal(r.body.message, ticket.description_text);
  assert.equal(r.body.email, ticket.requester.email);
  assert.equal(r.revision.length, 64);
  for (const req of requests) {
    assert.equal(new URL(req.url).origin, "https://chubbyclub.freshdesk.com");
    assert.equal(req.options.method, "GET");
    assert.equal(req.options.redirect, "error");
  }
});
test("no key, no agent ID and malformed ticket IDs fail closed without API calls", async () => {
  for (const id of [null, "", "0", "-1", "123/../agents", "https://evil.test", {}, "1?x=y"]) {
    assert.equal((await checkFreshdeskScope(id)).allowed, false);
  }
  delete process.env.FRESHDESK_API_KEY;
  assert.equal((await checkFreshdeskScope(123)).reason, "freshdesk_scope_not_configured");
  process.env.FRESHDESK_API_KEY = "fixture";
  delete process.env.FRESHDESK_CODY_AGENT_ID;
  assert.equal((await checkFreshdeskScope(123)).allowed, false);
  assert.equal(requests.length, 0);
});
test("unassigned and other-agent tickets never scan conversation history", async () => {
  for (const responder_id of [null, 99, undefined]) {
    ticket.responder_id = responder_id;
    assert.equal((await checkFreshdeskScope(123)).reason, "not_assigned_to_cody");
  }
  assert.equal(requests.length, 3);
});
test("Cody reply on second page, including an emailed reply, blocks", async () => {
  pages = [Array.from({ length: 30 }, (_, i) => conversation(i+1)), [conversation(31, { user_id: 42 })]];
  assert.equal((await checkFreshdeskScope(123)).reason, "cody_already_replied");
});
test("other authors' replies and Cody private notes do not count as Cody replies", async () => {
  pages = [[conversation(1), conversation(2, { user_id: 42, source: 2, private: true, incoming: false })]];
  assert.equal((await checkFreshdeskScope(123)).allowed, true);
});
test("Cody public note is conservatively treated as already handled", async () => {
  pages = [[conversation(1, { user_id: 42, source: 2, incoming: false })]];
  assert.equal((await checkFreshdeskScope(123)).reason, "cody_already_replied");
});
test("malformed, repeated or wrong-ticket history never permits processing", async () => {
  for (const page of [{}, [null], [conversation(1, { user_id: null })],
    [conversation(1, { ticket_id: 999 })], [conversation(1, { source: undefined })],
    [conversation(1), conversation(1)]]) {
    pages = [page];
    assert.equal((await checkFreshdeskScope(123)).reason, "freshdesk_history_incomplete");
  }
});
test("errors and non-200 responses never expose upstream errors", async () => {
  fail = true;
  const r = await checkFreshdeskScope(123);
  assert.equal(r.reason, "freshdesk_scope_unavailable");
  assert.equal(JSON.stringify(r).includes("private response"), false);
  globalThis.fetch = async () => ({ ok: false });
  assert.equal((await checkFreshdeskScope(123)).allowed, false);
});
test("ticket changes during scanning or between preview and application stop the write", async () => {
  const prior = await checkFreshdeskScope(123);
  ticket.description_text = "someone else@example.com";
  assert.equal((await checkFreshdeskScope(123, prior.revision)).reason, "freshdesk_ticket_changed");
  lateTicket = { ...ticket, responder_id: 99 };
  requests = [];
  assert.equal((await checkFreshdeskScope(123)).reason, "not_assigned_to_cody");
});
test("one-time scan requires current Open status, including before write", async () => {
  ticket.status = 3;
  assert.equal((await checkFreshdeskScope(123, undefined, { requireOpen: true })).reason, "ticket_not_open");
  ticket.status = 2;
  const scope = await checkFreshdeskScope(123, undefined, { requireOpen: true });
  assert.equal(scope.allowed, true);
  ticket.status = 4;
  assert.equal((await checkFreshdeskScope(123, scope.revision, { requireOpen: true })).reason, "ticket_not_open");
});
test("rate limits return only safe retry metadata", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => "17" } });
  const r = await checkFreshdeskScope(123);
  assert.equal(r.reason, "freshdesk_rate_limited");
  assert.equal(r.retryAfterSeconds, 17);
});
test("backfill skips unrelated and synthetic tickets before reading conversations", async () => {
  ticket.status = 2;
  ticket.subject = "Cancel membership"; ticket.description_text = "Please cancel";
  assert.equal((await checkFreshdeskScope(123, undefined, { onlyChubby1: true, requireOpen: true })).reason, "not_chubby1");
  ticket.subject = "AGENTTEST";
  assert.equal((await checkFreshdeskScope(123, undefined, { onlyChubby1: true, requireOpen: true })).reason, "synthetic_test_ticket");
  assert.equal(requests.length, 2);
});
