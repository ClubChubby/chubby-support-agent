export function classifyTicket({ subject = "", message = "" }) {
  const text = `${subject}\n${message}`.toLowerCase();

  if (/chubby1/.test(text)) return { workflow: "chubby1", confidence: 1 };

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
