import { checkFreshdeskScope } from "./freshdesk-scope.js";
import { processScopedTicket } from "./process-ticket.js";

import { backfillBatch } from "./backfill-config.js";
export { backfillBatch };

export async function runBackfill(batch) {
  const outcomes = [];
  const deadline = Math.min(batch.expiresAt, Date.now() + 220000);
  for (const ticketId of batch.ids) {
    let result;
    if (Date.now() >= deadline || process.env.CHUBBY1_APPLICATION_MODE !== "live") {
      result = { status: "deferred", reason: "backfill_expired_or_disabled", actionTaken: false };
    } else {
      let scope = await checkFreshdeskScope(ticketId, undefined, { requireOpen: true, requestDelayMs: 3000, onlyChubby1: true });
      if (scope.reason === "freshdesk_rate_limited") {
        const waitMs = Math.max(1000, (scope.retryAfterSeconds || 60) * 1000);
        if (Date.now() + waitMs + 30000 < deadline) {
          console.info(JSON.stringify({ event: "freshdesk_backfill_wait", batch: batch.batch, ticketId, seconds: waitMs / 1000 }));
          await new Promise(resolve => setTimeout(resolve, waitMs));
          scope = await checkFreshdeskScope(ticketId, undefined, { requireOpen: true, requestDelayMs: 3000, onlyChubby1: true });
        }
        if (scope.reason === "freshdesk_rate_limited") scope = { ...scope, status: "deferred" };
      }
      if (!scope.allowed) result = scope;
      else if (/AGENTTEST/i.test(scope.body.subject)) result = { status: "skipped", reason: "synthetic_test_ticket", actionTaken: false };
      else {
        result = (await processScopedTicket(scope, { requireOpen: true, requestDelayMs: 3000, expiresAt: deadline })).body;
      }
    }
    const entry = { event: "freshdesk_backfill_result", runId: batch.runId, batch: batch.batch, ticketId,
      workflow: result.classification?.workflow ?? null,
      status: result.status ?? "classified_read_only", reason: result.reason ?? null,
      actionTaken: result.actionTaken === null ? null : result.actionTaken === true };
    // Privacy allowlist only. No ticket content, contacts, approved list, or keys.
    console.info(JSON.stringify(entry));
    outcomes.push(entry);
  }
  return { ok: true, status: "backfill_batch_complete", batch: batch.batch, outcomes,
    actionTaken: outcomes.some(o => o.actionTaken === null) ? null : outcomes.some(o => o.actionTaken) };
}
