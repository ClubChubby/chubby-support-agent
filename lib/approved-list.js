import { createDecipheriv } from "node:crypto";
import { gunzipSync } from "node:zlib";
import encryptedList from "./approved-list-data.js";

export function decryptApprovedRecords(payload, keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || "")) throw new Error("Missing eligibility key");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const bytes = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]);
  const rows = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (!Array.isArray(rows) || rows.length !== payload.recordCount ||
      rows.some(row => row.eligible !== true || typeof row.email !== "string" || !row.email)) {
    throw new Error("Invalid approved list");
  }
  return rows;
}

let cachedKey, cachedRows;
export function loadApprovedRecords() {
  const key = process.env.CHUBBY1_ELIGIBILITY_KEY;
  if (!cachedRows || key !== cachedKey) {
    cachedRows = decryptApprovedRecords(encryptedList, key);
    cachedKey = key;
  }
  return cachedRows;
}
