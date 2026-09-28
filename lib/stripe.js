import Stripe from "stripe";
import { normalizeEmail, normalizePhone } from "./normalize.js";

function client() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

export async function findStripeCustomers({ email, phones = [] }) {
  const stripe = client();
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhones = new Set(phones.map(normalizePhone).filter(Boolean));
  const matches = new Map();

  if (normalizedEmail) {
    const byEmail = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
    for (const customer of byEmail.data) matches.set(customer.id, customer);
  }

  // Stripe does not offer an exact phone filter on customers.list, so v0 only
  // compares phone values among customers already found via email.
  for (const customer of [...matches.values()]) {
    const customerPhone = normalizePhone(customer.phone);
    if (normalizedPhones.size && customerPhone && normalizedPhones.has(customerPhone)) {
      customer._chubbyPhoneMatch = true;
    }
  }

  return [...matches.values()].map(c => ({
    id: c.id,
    email: c.email || null,
    phone: c.phone || null,
    phoneMatch: Boolean(c._chubbyPhoneMatch)
  }));
}
