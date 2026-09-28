import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { gzipSync } from "node:zlib";
import { decryptApprovedRecords, loadApprovedRecords } from "../lib/approved-list.js";

test("encrypted list authenticates contents and key", () => {
  const rows = [{ email: "approved@example.com", phone: "", eligible: true }];
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(rows))), cipher.final()]);
  const payload = { recordCount: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  assert.deepEqual(decryptApprovedRecords(payload, key.toString("hex")), rows);
  assert.throws(() => decryptApprovedRecords(payload, randomBytes(32).toString("hex")));
  assert.throws(() => decryptApprovedRecords({ ...payload, recordCount: 2 }, key.toString("hex")));
  assert.throws(() => decryptApprovedRecords(payload, ""));
  const tampered = Buffer.from(data); tampered[0] ^= 1;
  assert.throws(() => decryptApprovedRecords({ ...payload, data: tampered.toString("base64") }, key.toString("hex")));
});
test("legacy test allowlist cannot bypass the promotion list", () => {
  delete process.env.CHUBBY1_ELIGIBILITY_KEY;
  process.env.CHUBBY1_ELIGIBILITY_JSON = '[{"email":"attacker@example.com","eligible":true}]';
  assert.throws(() => loadApprovedRecords());
});
