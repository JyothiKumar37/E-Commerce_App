import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateShipping,
  calculateTax,
  calculateTotals,
  fromCents,
  sumCents,
  toCents,
} from "../src/money.js";

describe("cent conversion", () => {
  it("rounds rather than truncating", () => {
    assert.equal(toCents(24.99), 2499);
    assert.equal(toCents(0.1), 10);
    // 19.99 * 100 is 1998.9999... in IEEE-754; truncation would lose a cent.
    assert.equal(toCents(19.99), 1999);
  });

  it("accepts numeric strings", () => {
    assert.equal(toCents("12.34"), 1234);
  });

  it("round-trips", () => {
    assert.equal(fromCents(toCents(149.95)), 149.95);
  });

  it("throws on nonsense rather than silently producing NaN", () => {
    assert.throws(() => toCents("not a price"), TypeError);
  });
});

describe("shipping", () => {
  it("is free at or above the threshold", () => {
    assert.equal(calculateShipping(5000), 0);
    assert.equal(calculateShipping(9999), 0);
  });

  it("is a flat rate below the threshold", () => {
    assert.equal(calculateShipping(4999), 499);
  });

  it("is zero for an empty basket", () => {
    assert.equal(calculateShipping(0), 0);
  });
});

describe("tax", () => {
  it("applies the rate to the subtotal and rounds to whole cents", () => {
    assert.equal(calculateTax(10000, 0.19), 1900);
    assert.equal(calculateTax(999, 0.19), 190); // 189.81 -> 190
  });
});

describe("calculateTotals", () => {
  it("keeps the total exactly equal to its parts", () => {
    const items = [
      { unitPriceCents: 2499, quantity: 2 },
      { unitPriceCents: 1650, quantity: 1 },
    ];
    const totals = calculateTotals(items);

    assert.equal(totals.subtotalCents, 6648);
    assert.equal(totals.shippingCents, 0); // above the free threshold
    assert.equal(totals.taxCents, 1263);
    assert.equal(totals.totalCents, totals.subtotalCents + totals.shippingCents + totals.taxCents);
  });

  it("charges shipping on a small basket", () => {
    const totals = calculateTotals([{ unitPriceCents: 1650, quantity: 1 }]);

    assert.equal(totals.subtotalCents, 1650);
    assert.equal(totals.shippingCents, 499);
    assert.equal(totals.totalCents, 1650 + 499 + 314);
  });

  it("handles an empty cart without dividing by zero", () => {
    const totals = calculateTotals([]);
    assert.deepEqual(totals, {
      subtotalCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });

  it("never accumulates floating-point drift across many lines", () => {
    // 100 items at 33.33 each: a float pipeline drifts here, integers do not.
    const items = Array.from({ length: 100 }, () => ({ unitPriceCents: 3333, quantity: 1 }));
    const totals = calculateTotals(items);

    assert.equal(totals.subtotalCents, 333_300);
    assert.ok(Number.isInteger(totals.totalCents));
  });
});

describe("sumCents", () => {
  it("sums to an integer", () => {
    assert.equal(sumCents([100, 250, 33]), 383);
    assert.equal(sumCents([]), 0);
  });
});
