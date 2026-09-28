import { checkFreshdeskScope } from "./freshdesk-scope.js";
import { processScopedTicket } from "./process-ticket.js";

const BATCH_SIZE = 25;
// The ticket is just an authenticated trigger. Neither its body nor any webhook
// field can supply targets: the operator's frozen ID list lives only in Vercel.
export function backfillBatch(scope, now = Date.now()) {
  const match = /^CHUBBY1 BACKFILL ([a-f0-9]{32}) BATCH ([1-9]\d*)$/.exec(scope?.body?.subject || "");
  if (!match || !scope.allowed || process.env.VERCEL_ENV !== "production" ||
      process.env.CHUBBY1_APPLICATION_MODE !== "live") return null;
  try {
    const config = JSON.parse(process.env.CHUBBY1_BACKFILL || "null");
    if (!config || config.runId !== match[1] ||
        String(scope.requesterId) !== String(config.requesterId) || !/^[1-9]\d*$/.test(String(config.requesterId)) ||
        !Number.isFinite(config.expiresAt) || config.expiresAt <= now || config.expiresAt > now + 4*3600000 ||
        !Array.isArray(config.ticketIds) || !config.ticketIds.length || config.ticketIds.length > 300 ||
        config.ticketIds.some(id => typeof id !== "string" || !/^[1-9]\d*$/.test(id)) ||
        new Set(config.ticketIds).size !== config.ticketIds.length) return null;
    const batch = Number(match[2]);
    const ids = config.ticketIds.slice((batch-1)*BATCH_SIZE, batch*BATCH_SIZE);
    if (!ids.length) return null;
    return { runId: config.runId, batch, ids, expiresAt: config.expiresAt };
  } catch { return null; }
}

export async function runBackfill(batch) {
  const outcomes = [];
  const deadline = Math.min(batch.expiresAt, Date.now() + 220000);
  for (const ticketId of batch.ids) {
    let result;
    if (Date.now() >= deadline || process.env.CHUBBY1_APPLICATION_MODE !== "live") {
      result = { status: "deferred", reason: "backfill_expired_or_disabled", actionTaken: false };
    } else {
      let scope = await checkFreshdeskScope(ticketId, undefined, { requireOpen: true, requestDelayMs: 2500, onlyChubby1: true });
      if (scope.reason === "freshdesk_rate_limited") {
        const waitMs = Math.max(1000, (scope.retryAfterSeconds || 60) * 1000);
        if (Date.now() + waitMs + 30000 < deadline) {
          console.info(JSON.stringify({ event: "freshdesk_backfill_wait", batch: batch.batch, ticketId, seconds: waitMs / 1000 }));
          await new Promise(resolve => setTimeout(resolve, waitMs));
          scope = await checkFreshdeskScope(ticketId, undefined, { requireOpen: true, requestDelayMs: 2500, onlyChubby1: true });
        }
        if (scope.reason === "freshdesk_rate_limited") scope = { ...scope, status: "deferred" };
      }
      if (!scope.allowed) result = scope;
      else if (/AGENTTEST/i.test(scope.body.subject)) result = { status: "skipped", reason: "synthetic_test_ticket", actionTaken: false };
      else {
        result = (await processScopedTicket(scope, { requireOpen: true, requestDelayMs: 2500, expiresAt: deadline })).body;
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
