# Checkout — Business Requirements

> Documentation-only Gherkin (`Given/When/Then`) with stable scenario IDs. No Cucumber runner required — unit tests cite scenario IDs directly (e.g., `CHK-1.2`).

## Glossary

- **Subtotal**: Sum of line-item prices in integer minor units (cents), `>= 0`.
- **Discount**: Promotional deduction in integer minor units (cents), `>= 0`.
- **Total**: Final payable amount after applying discount, never negative.

## Rule CHK-1: Promotional Discount Clamping

Discounts reduce the checkout subtotal without ever producing a negative payable total.

### Scenario CHK-1.1: Discount smaller than subtotal

- **Given** a cart with subtotal `5000` cents ($50.00)
- **When** a promotional discount of `1200` cents ($12.00) is applied
- **Then** the payable total is `3800` cents ($38.00)
- **And** `clamped` is `false`

### Scenario CHK-1.2: Discount exceeding or matching subtotal clamps to zero

- **Given** a cart with subtotal `1500` cents ($15.00) — or a zero subtotal (`0` cents)
- **When** a promotional discount of `2500` cents ($25.00) is applied
- **Then** the payable total is clamped to `0` cents ($0.00)
- **And** `clamped` is `true` when `discount > subtotal`
- **And** negative subtotal or negative discount inputs throw a `RangeError`
