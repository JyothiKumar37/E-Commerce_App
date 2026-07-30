import { randomBytes } from "node:crypto";

/** Business days added to "now" per service level. */
export const TRANSIT_DAYS = { standard: 4, express: 2, overnight: 1 };

/** Skips weekends so the estimate matches how carriers actually operate. */
export function estimateDelivery(serviceLevel) {
  const date = new Date();
  let remaining = TRANSIT_DAYS[serviceLevel] ?? 4;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

export const generateTrackingNumber = (carrier) =>
  `${carrier.toUpperCase().slice(0, 3)}${randomBytes(6).toString("hex").toUpperCase()}`;
