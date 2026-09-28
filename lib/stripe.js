import Stripe from "stripe";
import { normalizeEmail, normalizePhone } from "./normalize.js";

export function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
  // Customer-level coupon application/discount reads use this stable API shape.
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20", maxNetworkRetries: 2, timeout: 15000 });
}

export async function findStripeCustomers({ email, phones = [], stripeCustomerId }) {
  const stripe = stripeClient();
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhones = new Set(phones.map(normalizePhone).filter(Boolean));
  const matches = new Map();

  if (stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      if (!customer.deleted) matches.set(customer.id, customer);
    } catch (error) {
      if (error.code !== "resource_missing") throw error;
    }
  } else if (normalizedEmail) {
    const byEmail = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
    for (const customer of byEmail.data) matches.set(customer.id, customer);
  }

  // Phone comparison is informational; account selection uses only the approved
  // record's customer ID (preferred) or email, never the ticket sender.
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
