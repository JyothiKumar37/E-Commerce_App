import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Payment provider abstraction.
 *
 * The mock provider never sees a real card. The API accepts only a
 * pre-tokenised payment method plus the display digits, mirroring how a real
 * PSP integration works (Stripe Elements, Adyen Components) — the card number
 * goes from the browser straight to the provider and never transits or lands
 * in this system. That keeps the service out of PCI-DSS scope entirely.
 */

const DECLINE_REASONS = ["insufficient_funds", "card_expired", "do_not_honour", "suspected_fraud"];

/**
 * Deterministic test tokens, so the frontend and integration tests can drive a
 * specific outcome instead of relying on the random decline rate.
 */
const FORCED_OUTCOMES = {
  tok_test_success: { approved: true },
  tok_test_decline: { approved: false, reason: "do_not_honour" },
  tok_test_insufficient_funds: { approved: false, reason: "insufficient_funds" },
  tok_test_expired: { approved: false, reason: "card_expired" },
};

export async function authorizeAndCapture({ amountCents, currency, method, paymentToken }) {
  if (config.MOCK_LATENCY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.MOCK_LATENCY_MS));
  }

  const forced = FORCED_OUTCOMES[paymentToken];
  const approved = forced ? forced.approved : Math.random() >= config.MOCK_DECLINE_RATE;

  if (!approved) {
    const reason =
      forced?.reason ?? DECLINE_REASONS[Math.floor(Math.random() * DECLINE_REASONS.length)];
    return { status: "failed", failureReason: reason, providerRef: `mock_${randomUUID()}` };
  }

  return {
    status: "captured",
    providerRef: `mock_${randomUUID()}`,
    capturedAmountCents: amountCents,
    currency,
    method,
  };
}

export async function refund({ providerRef, amountCents }) {
  if (config.MOCK_LATENCY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.MOCK_LATENCY_MS));
  }
  return {
    status: "refunded",
    providerRef: `mock_refund_${randomUUID()}`,
    originalRef: providerRef,
    refundedAmountCents: amountCents,
  };
}
