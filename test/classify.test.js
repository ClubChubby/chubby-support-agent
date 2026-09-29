import test from "node:test";
import assert from "node:assert/strict";
import { classifyTicket } from "../lib/classify.js";

test("recognizes a membership comeback text without the coupon name", () => {
  assert.equal(classifyTicket({ subject: "Trouble redeeming 1$ code", message:
    "A text offered my membership back for 1$. I tried before the deadline but the offer did not work."
  }).workflow, "chubby1");
});

test("recognizes campaign amounts and membership redemption language", () => {
  for (const message of [
    "My $1 membership promotion is not working",
    "I want to rejoin with the one-dollar membership offer",
    "The subscription renewal code for $1.00 failed",
    "Can you apply the $87 off membership offer?",
    "The discount of $87 for my Chubby Plus membership is missing",
    "I received an offer to reactivate my subscription for 1 dollar"
  ]) assert.equal(classifyTicket({ message }).workflow, "chubby1", message);
});

test("keeps vague promotions and unrelated amounts out of automatic campaign routing", () => {
  for (const message of [
    "My membership discount is missing", "I received a promotion by text",
    "My $10 membership promo failed", "My $1.99 membership promo failed",
    "My $187 off membership offer failed", "My membership costs $87",
    "My $87.50 off membership offer failed", "I have a $1 restaurant coupon",
    "I was charged $1 for my subscription", "Please refund the $1 membership promotion",
    "Cancel my subscription after the $1 offer", "CHUBBY10 membership discount"
  ]) assert.notEqual(classifyTicket({ message }).workflow, "chubby1", message);
});

test("screens standalone PLUS renewal, resubscription and purchase requests for one dollar", () => {
  for (const message of [
    "I received an SMS asking me to renew my PLUS with $1 with a promo code. The code is not valid.",
    "I am renewing PLUS for $1", "Can I resubscribe to PLUS for $1?",
    "I am resubscribing to Plus for 1$", "How do I re-subscribe to PLUS for one dollar?",
    "I want to purchase PLUS for $1", "Purchasing Plus for $1.00 does not work",
    "Can I buy Plus for one-dollar?", "I am buying PLUS for 1 dollar",
    "I want to sign up for PLUS for $1"
  ]) assert.equal(classifyTicket({ message }).workflow, "chubby1", message);
  assert.equal(classifyTicket({ subject: "PLUS renewal", message: "The $1 offer failed" }).workflow, "chubby1");
  for (const message of [
    "I am renewing PLUS for $58", "Purchase PLUS for $10", "Resubscribe to PLUS for $1.99",
    "Renew my PLUS", "I paid $58 plus $1 tax", "Please refund my purchase of PLUS for $1",
    "Cancel my PLUS after the $1 offer"
  ]) assert.notEqual(classifyTicket({ message }).workflow, "chubby1", message);
});

test("retains direct code and existing workflow behavior", () => {
  for (const message of ["CHUBBY1", "chubby 1", "Chubby   1 is not working"])
    assert.equal(classifyTicket({ message }).workflow, "chubby1");
  assert.equal(classifyTicket({ message: "Please cancel my membership" }).workflow, "cancellation");
  assert.equal(classifyTicket({ message: "Please refund my charge" }).workflow, "billing");
  assert.equal(classifyTicket({ message: "My membership discount is missing" }).workflow, "membership_benefits");
});
