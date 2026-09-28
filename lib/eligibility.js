import { normalizeEmail, normalizePhone } from "./normalize.js";

function loadEligibility() {
  const raw = process.env.CHUBBY1_ELIGIBILITY_JSON || "[]";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CHUBBY1_ELIGIBILITY_JSON must be a JSON array");
  return parsed;
}

export function findEligibility({ email, emails = [], phones = [] }) {
  const targetEmails = new Set([email, ...emails].map(normalizeEmail).filter(Boolean));
  const targetPhones = new Set(phones.map(normalizePhone).filter(Boolean));
  const matches = [];

  for (const row of loadEligibility()) {
    if (row?.eligible !== true) continue;
    const emailMatch = targetEmails.has(normalizeEmail(row.email));
    const phoneMatch = targetPhones.has(normalizePhone(row.phone));
    if (emailMatch || phoneMatch) {
      matches.push({ matched: true, matchedBy: emailMatch ? "email" : "phone", record: row });
    }
  }

  // Never choose the first of multiple approved records.
  if (matches.length > 1) {
    return { matched: false, ambiguous: true, matchedBy: null, record: null };
  }
  return matches[0] || { matched: false, matchedBy: null, record: null };
}
