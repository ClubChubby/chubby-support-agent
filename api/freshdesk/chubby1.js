import { checkFreshdeskScope } from "../../lib/freshdesk-scope.js";
import { verifyChubby1 } from "../../lib/chubby1.js";

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

  if (!req.body?.ticket_id) return json(res, 400, { ok: false, status: "manual_review", reason: "missing_ticket_id", actionTaken: false });
  const scope = await checkFreshdeskScope(req.body.ticket_id);
  if (!scope.allowed) return json(res, 200, { ok: true, ticketId: req.body.ticket_id, status: scope.status, reason: scope.reason, actionTaken: false });
  const result = await verifyChubby1(scope.body);
  return json(res, result.statusCode, result.body);
}
