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

test("retains direct code and existing workflow behavior", () => {
  for (const message of ["CHUBBY1", "chubby 1", "Chubby   1 is not working"])
    assert.equal(classifyTicket({ message }).workflow, "chubby1");
  assert.equal(classifyTicket({ message: "Please cancel my membership" }).workflow, "cancellation");
  assert.equal(classifyTicket({ message: "Please refund my charge" }).workflow, "billing");
  assert.equal(classifyTicket({ message: "My membership discount is missing" }).workflow, "membership_benefits");
});
