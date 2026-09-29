export function classifyTicket({ subject = "", message = "" }) {
  const text = `${subject}\n${message}`.toLowerCase();

  if (/\bchubby\s*1\b/.test(text)) return { workflow: "chubby1", confidence: 1 };

  // Recognize descriptions of the campaign without sending ticket content to
  // an external model. Routing is not eligibility: all account checks still run.
  const membership = /\b(?:membership|subscription|plus|chubby\s+club)\b/.test(text);
  const oneDollar = /(?:\$\s*1(?:\.00)?(?!\d|[.,]\d)\b|\b1(?:\.00)?\s*\$|\b(?:one|1)\s*(?:-\s*)?dollars?\b)/.test(text);
  const eightySevenOff = /(?:\$\s*87(?:\.00)?(?!\d|[.,]\d)\b|\b87(?:\.00)?\s*\$|\b87\s*dollars?\b)\s*(?:off|discount)|\b(?:discount|coupon|promo(?:tion)?)\s*(?:of|for|worth)?\s*\$\s*87(?:\.00)?(?!\d|[.,]\d)\b/.test(text);
  const offerOrReturn = /\b(?:offer|promo(?:tion)?|code|coupon|discount|reactivat\w*|rejoin\w*|re[\s-]?subscrib\w*|renew\w*|purchas\w*|buy(?:ing)?|bought|comeback|welcome\s+back)\b|\bsign(?:ing)?\s+up\b|\bmembership\s+back\b|\bjoin(?:ing)?(?:\s+\w+){0,8}\s+again\b/.test(text);
  // A billing dispute or cancellation mentioning a price is not a redemption request.
  const conflictingIntent = /\b(?:refund|unauthorized|double\s+charged|duplicate\s+charge)\b|\bcancel\s+(?:(?:my|the|this)\s+)?(?:membership|subscription|plus)\b/.test(text);
  // Short campaign subjects may carry the only offer details; the SMS itself
  // can be an image. Screen these without requiring "membership" in the body.
  const shortPromoSubject = /^(?:(?:re|fw|fwd):\s*)*(?:\$\s*1(?:\.00)?|1(?:\.00)?\s*\$|(?:one|1)[ -]+dollars?)\s+(?:promo(?:tion)?|offer)(?:\s+code)?[!?.]*\s*$/i.test(subject.trim());
  const otherPromotion = /\b(?:oneplus|restaurant|meal|food|birthday)\b/.test(text);
  if (shortPromoSubject && !conflictingIntent && !otherPromotion) {
    return { workflow: "chubby1", confidence: 0.9 };
  }
  if (membership && !conflictingIntent && ((oneDollar && offerOrReturn) || eightySevenOff)) {
    return { workflow: "chubby1", confidence: 0.9 };
  }

  if (/cancel|cancellation|cancelation|terminate membership/.test(text)) {
    return { workflow: "cancellation", confidence: 0.9 };
  }

  if (/refund|charged|charge|billing|duplicate charge|double charged/.test(text)) {
    return { workflow: "billing", confidence: 0.85 };
  }

  if (/login|log in|password|account access|can't access|cannot access/.test(text)) {
    return { workflow: "account_access", confidence: 0.85 };
  }

  if (/benefit|discount|plus member|membership benefit|promo|promotion/.test(text)) {
    return { workflow: "membership_benefits", confidence: 0.75 };
  }

  if (/app|bug|error|not working|doesn't work|does not work/.test(text)) {
    return { workflow: "app_support", confidence: 0.7 };
  }

  return { workflow: "manual_review", confidence: 0 };
}
