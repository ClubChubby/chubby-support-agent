import { classifyTicket } from "./classify.js";
import { createHash } from "node:crypto";

// Fixed destination: credentials can never be sent to a URL from a webhook.
const API = "https://chubbyclub.freshdesk.com/api/v2";
const positiveId = value => /^(?:[1-9]\d*)$/.test(String(value ?? ""));
const stop = (reason, status = "manual_review") => ({ allowed: false, status, reason, actionTaken: false });

async function read(path, key, signal, delayMs = 0) {
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  const response = await fetch(API + path, {
    method: "GET", redirect: "error", signal,
    headers: { Authorization: "Basic " + Buffer.from(key + ":X").toString("base64"), Accept: "application/json" }
  });
  if (!response.ok) {
    const error = new Error("freshdesk_unavailable");
    if (response.status === 429) {
      error.code = "freshdesk_rate_limited";
      const retry = Number(response.headers?.get("retry-after"));
      error.retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.min(120, Math.ceil(retry)) : 60;
    } else if ([401, 403, 404].includes(response.status)) error.code = "freshdesk_http_" + response.status;
    throw error;
  }
  return response.json();
}

function revision(ticket) {
  return createHash("sha256").update(JSON.stringify([
    ticket.id, ticket.responder_id, ticket.updated_at, ticket.subject,
    ticket.description_text, ticket.requester?.email, ticket.deleted, ticket.spam, ticket.status
  ])).digest("hex");
}

// Do not classify or search member identifiers until current assignment is verified.
// Never trust webhook claims about assignment, replies, or the ticket's content.
export async function checkFreshdeskScope(ticketId, expectedRevision, { requireOpen = false, requestDelayMs = 0, onlyChubby1 = false } = {}) {
  if (!positiveId(ticketId)) return stop("invalid_ticket_id");
  const key = process.env.FRESHDESK_API_KEY;
  const cody = process.env.FRESHDESK_CODY_AGENT_ID;
  if (!key || !positiveId(cody)) return stop("freshdesk_scope_not_configured");
  const signal = AbortSignal.timeout(requestDelayMs ? 30000 : 15000);
  try {
    const path = `/tickets/${ticketId}?include=requester`;
    const ticket = await read(path, key, signal, requestDelayMs);
    if (String(ticket?.id) !== String(ticketId)) return stop("freshdesk_ticket_invalid");
    if (String(ticket.responder_id) !== cody) return stop("not_assigned_to_cody", "skipped");
    if (requireOpen && ticket.status !== 2) return stop("ticket_not_open", "skipped");
    if (ticket.deleted === true || ticket.spam === true) return stop("freshdesk_ticket_unavailable");
    if (typeof ticket.subject !== "string" || typeof ticket.description_text !== "string" ||
        !Number.isFinite(Date.parse(ticket.updated_at))) return stop("freshdesk_ticket_incomplete");
    if (onlyChubby1 && /AGENTTEST/i.test(ticket.subject)) return stop("synthetic_test_ticket", "skipped");
    if (onlyChubby1 && classifyTicket({ subject: ticket.subject, message: ticket.description_text }).workflow !== "chubby1") {
      return stop("not_chubby1", "skipped");
    }
    const currentRevision = revision(ticket);
    if (expectedRevision && currentRevision !== expectedRevision) return stop("freshdesk_ticket_changed");

    // The embedded conversations field is capped at ten. Always use the full,
    // paginated endpoint, and fail closed on malformed/repeated/too-long history.
    const seen = new Set();
    let complete = false;
    for (let page = 1; page <= 100; page++) {
      const conversations = await read(`/tickets/${ticketId}/conversations?per_page=30&page=${page}`, key, signal, requestDelayMs);
      if (!Array.isArray(conversations) || conversations.length > 30) return stop("freshdesk_history_incomplete");
      for (const conversation of conversations) {
        if (!positiveId(conversation?.id) || seen.has(conversation.id) ||
            String(conversation.ticket_id) !== String(ticketId) || !positiveId(conversation.user_id) ||
            typeof conversation.private !== "boolean" || typeof conversation.incoming !== "boolean" ||
            !Number.isInteger(conversation.source)) return stop("freshdesk_history_incomplete");
        seen.add(conversation.id);
        // A reply authored by Cody counts even when sent through email (incoming).
        // Conservatively also stop for his public notes; private notes are not replies.
        if (String(conversation.user_id) === cody &&
            (conversation.source === 0 || !conversation.private)) return stop("cody_already_replied", "skipped");
      }
      if (conversations.length < 30) { complete = true; break; }
    }
    if (!complete) return stop("freshdesk_history_incomplete");
    const latest = await read(path, key, signal, requestDelayMs);
    if (String(latest?.responder_id) !== cody) return stop("not_assigned_to_cody", "skipped");
    if (revision(latest) !== currentRevision) return stop("freshdesk_ticket_changed");
    return { allowed: true, requesterId: ticket.requester_id, revision: currentRevision, body: {
      ticket_id: String(ticketId), subject: ticket.subject, message: ticket.description_text,
      email: typeof ticket.requester?.email === "string" ? ticket.requester.email : ""
    } };
  } catch (error) {
    // Never expose response bodies, conversation content, or credentials in errors.
    const reason = ["freshdesk_rate_limited", "freshdesk_http_401", "freshdesk_http_403", "freshdesk_http_404"].includes(error.code) ? error.code : "freshdesk_scope_unavailable";
    return { ...stop(reason), ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
  }
}
