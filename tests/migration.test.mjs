import test from "node:test";
import assert from "node:assert/strict";
import { normalizeState, calculateInventory } from "../src/core.mjs";
import { validateState } from "../src/state-validation.mjs";
const original = {
  products: [{ id: "film", category: "相纸", series: "SQ", model: "双白", capacity: 20, officialPrice: 100 }],
  transactions: [
    { id: "buy", lotId: "batch", date: "2026-07-01", type: "purchase", productId: "film", quantity: 3, unitPrice: 70, region: "示例平台" },
    { id: "sale", lotId: "batch", date: "2026-08-01", type: "sale", productId: "film", quantity: 1, unitPrice: 110 },
    { id: "use", lotId: "batch", date: "2026-08-02", type: "use", productId: "film", quantity: .5, unitPrice: 0 },
  ],
};
test("JSON migration retains batch links, profits, fractional boxes, platform", () => {
  const migrated = validateState(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(calculateInventory(migrated), calculateInventory(normalizeState(original)));
  assert.equal(calculateInventory(migrated).activeBatches[0].quantity, 1.5);
  assert.equal(migrated.transactions[2].lotId, "batch");
});
test("corrupt migration is rejected instead of silently dropping associations", () => {
  assert.throws(() => validateState({ ...original, products: [] }), /商品缺失/);
  assert.throws(() => validateState({ ...original, transactions: [original.transactions[0], original.transactions[0]] }), /重复/);
});
