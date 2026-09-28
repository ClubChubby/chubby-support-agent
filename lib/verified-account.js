import { normalizeEmail, normalizePhone } from "./normalize.js";

// Operator-verified links live only in the private, expiring batch configuration.
// They cannot grant list eligibility or be supplied by a ticket/webhook.
export function verifiedAccount({ ticketId, email, phones = [] }, now = Date.now()) {
  if (process.env.VERCEL_ENV !== "production" || process.env.CHUBBY1_APPLICATION_MODE !== "live") return null;
  let config;
  try { config = JSON.parse(process.env.CHUBBY1_BACKFILL || "null"); } catch { return null; }
  if (!config || !Number.isFinite(config.expiresAt) || config.expiresAt <= now ||
      config.expiresAt > now + 4 * 3600000 || !config.ticketIds?.includes(String(ticketId))) return null;
  const links = config.accountMatches;
  if (!Array.isArray(links)) return null;
  const matches = links.filter(link => String(link.ticketId) === String(ticketId));
  if (!matches.length) return null;
  const link = matches[0];
  if (matches.length !== 1 || !/^cus_[A-Za-z0-9]+$/.test(link.customerId || "") ||
      !normalizeEmail(email) || normalizeEmail(link.email) !== normalizeEmail(email) ||
      !/^\d{10}$/.test(normalizePhone(link.phone)) ||
      !phones.map(normalizePhone).includes(normalizePhone(link.phone))) {
    throw new Error("Invalid verified account link");
  }
  return link;
}

export function matchesVerifiedAccount(customer, link) {
  if (!customer || customer.deleted || customer.id !== link.customerId) return false;
  if (normalizeEmail(customer.email || "") === normalizeEmail(link.email)) return true;
  // A missing email requires both the independently verified app UID and phone.
  return !normalizeEmail(customer.email || "") && typeof link.userId === "string" && !!link.userId &&
    customer.metadata?.uid === link.userId && normalizePhone(customer.phone) === normalizePhone(link.phone);
}
