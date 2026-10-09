import test from "node:test";
import assert from "node:assert/strict";
import { calculateInventory, nextSerial, normalizeState, validateTransaction, transactionStatus } from "../src/core.mjs";

const state = {
  settings: { expiryWarningDays: 90 },
  products: [
    { id: "film001", category: "相纸", series: "Mini", model: "白边", spec: "单白", capacity: 10, officialPrice: 62, marketPrice: 65 },
    { id: "film002", category: "相纸", series: "SQ", model: "彩虹", spec: "单盒", capacity: 10, officialPrice: 80, marketPrice: 80 },
    { id: "cam001", category: "相机", series: "SQ", model: "SQ6", spec: "Taylor Swift", capacity: 1, officialPrice: 1800, marketPrice: 1800 },
  ],
  transactions: [
    { id: "tx1", date: "2026-01-01", createdAt: "1", type: "purchase", productId: "film001", expiry: "2026-12-01", quantity: 5, unitPrice: 50 },
    { id: "tx2", date: "2026-01-02", createdAt: "2", type: "sale", productId: "film001", expiry: "2026-12-01", quantity: 2, unitPrice: 80 },
    { id: "tx3", date: "2026-01-03", createdAt: "3", type: "sale", productId: "film001", expiry: "2026-12-01", quantity: 1, unitPrice: 50, originalTransfer: true },
    { id: "tx4", date: "2026-01-04", createdAt: "4", type: "use", productId: "film001", expiry: "2026-12-01", quantity: 1, unitPrice: 0 },
    { id: "tx5", date: "2026-01-01", createdAt: "5", type: "purchase", productId: "film002", expiry: "2026-03-01", quantity: 1, unitPrice: 60 },
    { id: "tx6", date: "2026-01-10", createdAt: "6", type: "use", productId: "film002", expiry: "2026-03-01", quantity: 1, unitPrice: 0 },
  ],
};

test("库存、相纸张数和价值按批次正确计算", () => {
  const result = calculateInventory(state, new Date("2026-09-18T00:00:00"));
  assert.equal(result.activeBatches.length, 1);
  assert.equal(result.activeBatches[0].quantity, 1);
  assert.equal(result.filmSheets.Mini, 10);
  assert.equal(result.filmSheets.SQ, 0);
  assert.equal(result.inventoryCostValue, 50);
  assert.equal(result.inventoryOfficialValue, 62);
  assert.equal(result.inventoryMarketValue, 65);
});

test("朋友原价转让不计入真实利润和平均售价", () => {
  const result = calculateInventory(state, new Date("2026-09-18T00:00:00"));
  assert.equal(result.trueProfit, 60);
  assert.equal(result.productStats.find((x) => x.product.id === "film001").averageSalePrice, 80);
  assert.equal(result.saleTotal, 210);
});

test("使用金额按扣减时平均购入成本计算", () => {
  const result = calculateInventory(state, new Date("2026-09-18T00:00:00"));
  assert.equal(result.useCost, 110);
});

test("库存为零的相纸不进入到期提醒", () => {
  const result = calculateInventory(state, new Date("2026-01-01T00:00:00"));
  assert.equal(result.expiring.some((x) => x.product.id === "film002"), false);
});

test("修改提醒天数会改变即将过期列表", () => {
  const shortRange = calculateInventory({ ...state, settings: { expiryWarningDays: 90 } }, new Date("2026-09-18T00:00:00"));
  const longRange = calculateInventory({ ...state, settings: { expiryWarningDays: 120 } }, new Date("2026-09-18T00:00:00"));
  assert.equal(shortRange.expiring.some((x) => x.product.id === "film001"), false);
  assert.equal(longRange.expiring.some((x) => x.product.id === "film001"), true);
});

test("禁止超库存售出或使用", () => {
  const message = validateTransaction(state, {
    date: "2026-02-01",
    type: "sale",
    productId: "film001",
    expiry: "2026-12-01",
    quantity: 2,
    unitPrice: 70,
  });
  assert.match(message, /仅剩 1/);
});

test("修改购入流水时可识别由后续流水造成的负库存", () => {
  const editedTransactions = state.transactions.map((tx) => tx.id === "tx1" ? { ...tx, quantity: 3 } : tx);
  const result = calculateInventory({ ...state, transactions: editedTransactions });
  assert.equal(result.negativeBatches.length, 1);
  assert.equal(result.negativeBatches[0].quantity, -1);
});

test("旧版花边字段自动迁移为具体型号", () => {
  const migrated = normalizeState({ products: [{ id: "p1", category: "相纸", series: "Mini", model: "花边", spec: "kitty", capacity: 10 }] });
  assert.equal(migrated.products[0].model, "kitty");
  assert.equal(migrated.products[0].spec, "");
});

test("有效期统一到年月，缺失有效期仍可先录入", () => {
  const migrated = normalizeState({
    products: [{ id: "film", category: "相纸", series: "Mini", model: "白边", capacity: 10 }],
    transactions: [{ id: "old", type: "purchase", productId: "film", date: "2026-09-18", expiry: "2027-05-16", quantity: 1 }],
  });
  assert.equal(migrated.transactions[0].expiry, "2027-05");
  assert.equal(validateTransaction(migrated, { type: "purchase", productId: "film", date: "2026-09-18", quantity: 1, expiry: "" }), "");
});

test("普通相机不保存有效期", () => {
  const migrated = normalizeState({
    products: [{ id: "camera", category: "相机", series: "SQ", model: "SQ6", capacity: 1 }],
    transactions: [{ id: "camera-buy", type: "purchase", productId: "camera", date: "2026-09-18", expiry: "2030-12-01", quantity: 1 }],
  });
  assert.equal(migrated.transactions[0].expiry, "");
});

test("相纸数量只允许整盒或半盒，相机只允许整台", () => {
  assert.equal(validateTransaction(state, { type: "purchase", productId: "film001", date: "2026-09-18", quantity: 1.5 }), "");
  assert.match(validateTransaction(state, { type: "purchase", productId: "film001", date: "2026-09-18", quantity: 1.25 }), /0.5 盒/);
  assert.match(validateTransaction(state, { type: "purchase", productId: "cam001", date: "2026-09-18", quantity: 0.5 }), /整台/);
});

test("编号和购入流水状态符合规则", () => {
  assert.equal(nextSerial(state, "相纸"), "film001");
  assert.equal(nextSerial(state, "相机"), "cam001");
  assert.equal(transactionStatus(state, "tx1"), "库存 1");
  assert.equal(transactionStatus(state, "tx3"), "原价转让");
});


 test("历史购入均价包含已清空批次并按数量加权", () => {
 const input = { products: [state.products[0]], transactions: [
 { id: "old", type: "purchase", productId: "film001", lotId: "old", date: "2025-01-01", quantity: 1, unitPrice: 100 },
 { id: "sold", type: "sale", productId: "film001", lotId: "old", date: "2025-01-02", quantity: 1, unitPrice: 150 },
 { id: "new", type: "purchase", productId: "film001", lotId: "new", date: "2026-01-01", quantity: 9, unitPrice: 60 },
 ] };
 const result = calculateInventory(input);
 assert.equal(result.productStats[0].averagePurchasePrice, 64);
 assert.equal(result.activeBatches[0].averageCost, 60);
 });
