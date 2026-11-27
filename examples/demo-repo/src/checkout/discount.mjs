/**
 * Pure checkout discount calculation in integer minor units (cents).
 * Implements CHK-1.1 and CHK-1.2 from docs/requirements/checkout/REQUIREMENTS.md.
 *
 * @param {number} subtotalCents
 * @param {number} discountCents
 * @returns {{ totalCents: number, clamped: boolean }}
 */
export function applyDiscount(subtotalCents, discountCents) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new RangeError('subtotalCents must be a non-negative integer');
  }
  if (!Number.isInteger(discountCents) || discountCents < 0) {
    throw new RangeError('discountCents must be a non-negative integer');
  }
  if (discountCents > subtotalCents) {
    return { totalCents: 0, clamped: true };
  }
  return { totalCents: subtotalCents - discountCents, clamped: false };
}
