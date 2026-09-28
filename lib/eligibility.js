import { normalizeEmail, normalizePhone } from "./normalize.js";

function loadEligibility() {
  const raw = process.env.CHUBBY1_ELIGIBILITY_JSON || "[]";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CHUBBY1_ELIGIBILITY_JSON must be a JSON array");
  return parsed;
}

export function findEligibility({ email, phones = [] }) {
  const targetEmail = normalizeEmail(email);
  const targetPhones = new Set(phones.map(normalizePhone).filter(Boolean));

  for (const row of loadEligibility()) {
    if (row?.eligible !== true) continue;
    const rowEmail = normalizeEmail(row.email);
    const rowPhone = normalizePhone(row.phone);

    if (targetEmail && rowEmail && targetEmail === rowEmail) {
      return { matched: true, matchedBy: "email", record: row };
    }
    if (rowPhone && targetPhones.has(rowPhone)) {
      return { matched: true, matchedBy: "phone", record: row };
    }
  }

  return { matched: false, matchedBy: null, record: null };
}
