import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apportion,
  cancel,
  couponAmount,
  demoBond,
  parseMoney,
  schedule,
  settleHolder,
  snapshot,
  validateBond,
} from "../src/lib/engine";
const initial = () => demoBond(1000, ["a", "b", "c"], "issuer");
const ready = () =>
  snapshot(schedule(initial(), "issuer", "coupon", 1060, "0", 1000), 0, 1060);
test("specified coupon and principal examples use exact integers", () => {
  assert.equal(couponAmount(10n, 1_000_000_000n, 1000, 2), 500_000_000n);
  assert.equal(parseMoney("10000"), "10000000000");
  assert.equal(parseMoney("0.000001"), "1");
  assert.throws(() => parseMoney("1.0000001"));
});
test("full lifecycle: coupon, partial redemption, remaining principal", () => {
  let b = ready();
  assert.equal(b.actions[0].total, "2000000000");
  assert.equal(b.actions[0].entitlements[0].eligibleQuantity, "10");
  for (let i = 0; i < 3; i++) b = settleHolder(b, "issuer", 0, i);
  assert.equal(b.couponCount, 1);
  b = snapshot(schedule(b, "issuer", "early", 1100, "10", 1060), 1, 1100);
  assert.deepEqual(
    b.actions[1].entitlements.map((e) => e.quantity),
    ["3", "5", "2"],
  );
  for (let i = 0; i < 3; i++) b = settleHolder(b, "issuer", 1, i);
  assert.equal(b.outstanding, "30");
  assert.equal(
    b.actions[0].entitlements[0].eligibleQuantity,
    "10",
    "Historic eligibility must not change with later redemptions",
  );
  b = snapshot(schedule(b, "issuer", "redemption", 1360, "0", 1100), 2, 1360);
  for (let i = 0; i < 3; i++) b = settleHolder(b, "issuer", 2, i);
  assert.equal(b.outstanding, "0");
  assert.equal(b.treasury, "8000000000");
  assert.equal(b.actions[2].status, "completed");
  assert.throws(
    () => schedule(b, "issuer", "coupon", 1400, "0", 1360),
    /fully redeemed/,
  );
});
test("reject early snapshot, early maturity, unauthorized and parallel actions", () => {
  assert.throws(() =>
    snapshot(schedule(initial(), "issuer", "coupon", 1060, "0", 1000), 0, 1059),
  );
  assert.throws(() => schedule(initial(), "other", "coupon", 1060, "0", 1000));
  assert.throws(() =>
    schedule(initial(), "issuer", "redemption", 1100, "0", 1000),
  );
  assert.throws(() => schedule(ready(), "issuer", "early", 1100, "10", 1060));
  assert.throws(() => settleHolder(ready(), "other", 0, 0));
});
test("settlement is retryable and cannot pay twice; failed funding is atomic", () => {
  let b = settleHolder(ready(), "issuer", 0, 0);
  assert.throws(() => settleHolder(b, "issuer", 0, 0), /already been settled/);
  const empty = { ...b, treasury: "0" };
  const before = JSON.stringify(empty);
  assert.throws(() => settleHolder(empty, "issuer", 0, 1), /Insufficient/);
  assert.equal(JSON.stringify(empty), before);
  assert.throws(() => cancel(b, "issuer", 0));
  b = settleHolder(b, "issuer", 0, 1);
  b = settleHolder(b, "issuer", 0, 2);
  assert.throws(
    () => schedule(b, "issuer", "coupon", 1060, "0", 1060),
    /not due/,
  );
});
test("cancelled actions can be rescheduled without skipping a coupon", () => {
  let b = cancel(ready(), "issuer", 0);
  b = schedule(b, "issuer", "coupon", 1061, "0", 1060);
  assert.equal(b.actions[1].couponIndex, 1);
});
test("largest remainder never loses principal or over-redeems", () => {
  for (let a = 1; a < 10; a++)
    for (let b = 1; b < 10; b++)
      for (let target = 1; target <= a + b; target++) {
        const shares = apportion([BigInt(a), BigInt(b), 0n], BigInt(target));
        assert.equal(
          shares.reduce((s, q) => s + q, 0n),
          BigInt(target),
        );
        assert.ok(shares[0] <= BigInt(a) && shares[1] <= BigInt(b));
        assert.equal(shares[2], 0n);
      }
});
test("validation rejects duplicated holders, invalid terms and overflow", () => {
  validateBond(initial());
  assert.throws(() =>
    validateBond({
      ...initial(),
      holders: [initial().holders[0], initial().holders[0]],
    }),
  );
  assert.throws(() => couponAmount(1n, 1n, 1, 0));
  assert.throws(() => parseMoney("18446744073709551616"));
});
