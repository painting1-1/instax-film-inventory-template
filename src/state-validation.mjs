import { normalizeState, calculateInventory } from "./core.mjs";
export function validateState(input) {
  if (!input || !Array.isArray(input.products) || !Array.isArray(input.transactions)) throw new Error("请选择本站导出的完整 JSON 备份");
  const products = new Set(), transactions = new Set();
  for (const product of input.products) {
    if (!product || typeof product.id !== "string" || !product.id || products.has(product.id)) throw new Error("商品编号缺失或重复");
    if (!["相纸", "相机"].includes(product.category)) throw new Error("商品仅支持相机和相纸");
    products.add(product.id);
  }
  for (const tx of input.transactions) {
    if (!tx || typeof tx.id !== "string" || !tx.id || transactions.has(tx.id)) throw new Error("流水编号缺失或重复");
    if (!products.has(tx.productId)) throw new Error("流水关联的商品缺失");
    if (!["purchase", "sale", "use"].includes(tx.type) || !Number.isFinite(Number(tx.quantity)) || Number(tx.quantity) <= 0 || !Number.isFinite(Number(tx.unitPrice)) || Number(tx.unitPrice) < 0) throw new Error("流水数量或金额无效");
    transactions.add(tx.id);
  }
  for (const tx of input.transactions) {
    if (tx.sourcePurchaseId && !input.transactions.some(source => source.id === tx.sourcePurchaseId && source.type === "purchase" && source.productId === tx.productId)) throw new Error("售出或使用流水关联的购入记录缺失");
  }
  return normalizeState(input);
}
export function migrationSummary(state) {
  const normalized = validateState(state);
  const stats = calculateInventory(normalized);
  return { products: normalized.products.length, transactions: normalized.transactions.length, stats };
}
