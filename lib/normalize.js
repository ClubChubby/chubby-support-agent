export function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

export function normalizePhone(value = "") {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function extractPhones(text = "") {
  const matches = String(text).match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  return [...new Set(matches.map(normalizePhone).filter(Boolean))];
}

export function extractEmails(text = "") {
  const matches = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) || [];
  return [...new Set(matches.map(normalizeEmail))];
}
