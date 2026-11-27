import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiscount } from '../src/checkout/discount.mjs';

test('CHK-1.1: applies discount smaller than subtotal without clamping', () => {
  assert.deepEqual(applyDiscount(5000, 1200), { totalCents: 3800, clamped: false });
});

test('CHK-1.2: clamps total to zero when discount exceeds subtotal', () => {
  assert.deepEqual(applyDiscount(1500, 2500), { totalCents: 0, clamped: true });
});

test('CHK-1.2: handles zero-subtotal cart cleanly', () => {
  assert.deepEqual(applyDiscount(0, 500), { totalCents: 0, clamped: true });
  assert.deepEqual(applyDiscount(0, 0), { totalCents: 0, clamped: false });
});

test('CHK-1.2: rejects negative or non-integer amounts', () => {
  assert.throws(() => applyDiscount(-100, 50), RangeError);
  assert.throws(() => applyDiscount(100, -10), RangeError);
  assert.throws(() => applyDiscount(10.5, 5), RangeError);
});
