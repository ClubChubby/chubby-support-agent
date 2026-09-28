import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedAccount, matchesVerifiedAccount } from "../lib/verified-account.js";

test("private mapping requires approved identifiers, exact ticket, live mode and unexpired scope", () => {
  const now = Date.now();
  const link = { ticketId: "123", email: "approved@example.com", phone: "+16265550123", customerId: "cus_verified", userId: "fixtureUid" };
  const config = { expiresAt: now + 60000, ticketIds: ["123"], accountMatches: [link] };
  const args = { ticketId: "123", email: "approved@example.com", phones: ["6265550123"] };
  process.env.VERCEL_ENV = "production";
  process.env.CHUBBY1_APPLICATION_MODE = "live";
  process.env.CHUBBY1_BACKFILL = JSON.stringify(config);
  assert.deepEqual(verifiedAccount(args, now), link);
  assert.equal(verifiedAccount({ ...args, ticketId: "124" }, now), null);
  assert.throws(() => verifiedAccount({ ...args, email: "other@example.com" }, now));
  assert.throws(() => verifiedAccount({ ...args, phones: ["6265559999"] }, now));
  assert.equal(verifiedAccount(args, now + 60000), null);
  process.env.VERCEL_ENV = "preview";
  assert.equal(verifiedAccount(args, now), null);
  process.env.VERCEL_ENV = "production";
  process.env.CHUBBY1_BACKFILL = JSON.stringify({ ...config, accountMatches: [link, link] });
  assert.throws(() => verifiedAccount(args, now));
  process.env.CHUBBY1_BACKFILL = "disabled";
  assert.equal(verifiedAccount(args, now), null);
});

test("retrieved account must match email or both verified UID and phone when email is missing", () => {
  const link = { email: "approved@example.com", phone: "6265550123", customerId: "cus_verified", userId: "fixtureUid" };
  assert.equal(matchesVerifiedAccount({ id: link.customerId, email: "Approved@Example.com" }, link), true);
  const noEmail = { id: link.customerId, email: null, phone: "+16265550123", metadata: { uid: "fixtureUid" } };
  assert.equal(matchesVerifiedAccount(noEmail, link), true);
  for (const change of [{ deleted: true }, { id: "cus_other" }, { email: "other@example.com" }, { phone: "6265559999" }, { metadata: {} }]) {
    assert.equal(matchesVerifiedAccount({ ...noEmail, ...change }, link), false);
  }
});
