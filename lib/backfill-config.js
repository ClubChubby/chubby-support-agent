const DEFAULT_BATCH_SIZE = 25;
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
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25) return null;
    const batch = Number(match[2]);
    const ids = config.ticketIds.slice((batch-1)*batchSize, batch*batchSize);
    if (!ids.length) return null;
    return { runId: config.runId, batch, ids, expiresAt: config.expiresAt };
  } catch { return null; }
}

