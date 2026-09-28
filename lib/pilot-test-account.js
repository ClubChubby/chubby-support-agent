import { normalizeEmail, normalizePhone } from "./normalize.js";

// Owner-authorized test exception, private deployment config only. Never alters
// the promotion list; never available to real traffic, direct verification, or live mode.
export function pilotTestAccount({ subject, email, emails, phones }) {
  if (process.env.VERCEL_ENV !== "production" || process.env.CHUBBY1_APPLICATION_MODE !== "pilot" ||
      subject !== "AGENTTEST") return null;
  try {
    const record = JSON.parse(process.env.CHUBBY1_PILOT_TEST_ACCOUNT || "null");
    if (!record || !/^cus_[A-Za-z0-9]+$/.test(record.stripeCustomerId || "") ||
        !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() ||
        record.expiresAt > Date.now() + 86400000) return null;
    const allowed = (process.env.CHUBBY1_PILOT_CUSTOMERS || "").split(",").map(s => s.trim());
    if (!allowed.includes(record.stripeCustomerId)) return null;
    const approvedEmail = normalizeEmail(record.email);
    const approvedPhone = normalizePhone(record.phone);
    if (!approvedEmail || !approvedPhone ||
        ![email, ...emails].includes(approvedEmail) || !phones.includes(approvedPhone)) return null;
    return { matched: true, matchedBy: "owner_authorized_pilot", record };
  } catch { return null; }
}
