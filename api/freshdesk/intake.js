import { classifyTicket } from "../../lib/classify.js";

function json(res, status, body) {
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

  const body = req.body || {};
  const ticketId = body.ticket_id ?? null;
  const subject = body.subject || "";
  const message = body.message || "";

  if (!ticketId) {
    return json(res, 400, {
      ok: false,
      status: "manual_review",
      reason: "missing_ticket_id"
    });
  }

  const classification = classifyTicket({ subject, message });

  return json(res, 200, {
    ok: true,
    ticketId,
    classification,
    actionTaken: false,
    nextStep:
      classification.workflow === "chubby1"
        ? "route_to_chubby1_workflow"
        : "workflow_not_implemented_yet"
  });
}
