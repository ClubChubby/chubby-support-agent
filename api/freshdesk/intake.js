import { checkFreshdeskScope } from "../../lib/freshdesk-scope.js";
import { verifyChubby1 } from "../../lib/chubby1.js";
import { classifyTicket } from "../../lib/classify.js";
import { applicationEnabled, applyChubby1 } from "../../lib/coupon-application.js";

function json(res, status, body) {
  // Allowlisted outcome fields only: never log payloads, identifiers, or secrets.
  console.info(JSON.stringify({
    event: "freshdesk_intake_result",
    workflow: body.classification?.workflow ?? null,
    status: body.status ?? (body.ok ? "classified_read_only" : "rejected"),
    reason: body.reason ?? body.error ?? null,
    previewEligible: body.preview?.eligible ?? null,
    couponId: body.preview?.couponId ?? null,
    httpStatus: status,
    ticketId: /^\d+$/.test(String(body.ticketId ?? "")) ? String(body.ticketId) : null,
    actionTaken: body.actionTaken === null ? null : body.actionTaken === true
  }));
  res.status(status).setHeader("content-type", "application/json");
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret) {
    return json(res, 500, { ok: false, error: "server_not_configured" });
  }

  const suppliedSecret = req.headers["x-chubby-webhook-secret"];
  if (suppliedSecret !== expectedSecret) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  const ticketId = req.body?.ticket_id ?? null;

  if (!ticketId) {
    return json(res, 400, {
      ok: false,
      status: "manual_review",
      reason: "missing_ticket_id"
    });
  }

  const scope = await checkFreshdeskScope(ticketId);
  if (!scope.allowed) return json(res, 200, { ok: true, ticketId, status: scope.status, reason: scope.reason, actionTaken: false });
  const body = scope.body;
  const { subject, message } = body;
  const classification = classifyTicket({ subject, message });

  if (classification.workflow === "chubby1") {
    const result = await verifyChubby1(body, { allowPilotException: true });
    if (result.body.status === "preview_ready_read_only" &&
        applicationEnabled(result.body.stripeCustomer.id, subject)) {
      const applied = await applyChubby1(result.body.stripeCustomer.id, subject, { ticketId, revision: scope.revision });
      return json(res, 200, { ...result.body, ...applied, classification });
    }
    return json(res, result.statusCode, { ...result.body, classification });
  }

  return json(res, 200, {
    ok: true,
    ticketId,
    classification,
    actionTaken: false,
    nextStep: "workflow_not_implemented_yet"
  });
}
