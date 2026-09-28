import { verifyChubby1 } from "./chubby1.js";
import { classifyTicket } from "./classify.js";
import { applicationEnabled, applyChubby1 } from "./coupon-application.js";

// Shared processing of API-verified ticket content for intake and one-time scans.
export async function processScopedTicket(scope, options = {}) {
  const body = scope.body;
  const ticketId = body.ticket_id;
  const classification = classifyTicket(body);
  if (classification.workflow === "chubby1") {
    const result = await verifyChubby1(body, { allowPilotException: options.allowPilotException === true });
    if (result.body.status === "preview_ready_read_only" && applicationEnabled(result.body.stripeCustomer.id, body.subject)) {
      const applied = await applyChubby1(result.body.stripeCustomer.id, body.subject, {
        ticketId, revision: scope.revision, requireOpen: options.requireOpen === true,
        requestDelayMs: options.requestDelayMs || 0, expiresAt: options.expiresAt
      });
      return { statusCode: 200, body: { ...result.body, ...applied, classification } };
    }
    return { ...result, body: { ...result.body, classification } };
  }
  return { statusCode: 200, body: { ok: true, ticketId, classification, actionTaken: false,
    nextStep: "workflow_not_implemented_yet" } };
}
