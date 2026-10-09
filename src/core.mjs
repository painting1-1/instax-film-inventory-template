export const FILM_SERIES = ["Mini", "SQ", "Wide"];

export const EMPTY_STATE = Object.freeze({
  products: [],
  transactions: [],
  settings: { expiryWarningDays: 90 },
});

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function money(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(number);
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeState(input) {
  const source = input && typeof input === "object" ? input : {};
  const products = Array.isArray(source.products) ? source.products.map(normalizeProduct) : [];
  const productCategories = new Map(products.map((product) => [product.id, product.category]));
  return {
    products,
    transactions: Array.isArray(source.transactions) ? source.transactions.map((item) => {
      const transaction = normalizeTransaction(item);
      if (productCategories.get(transaction.productId) === "相机") transaction.expiry = "";
      return transaction;
    }) : [],
    settings: {
      expiryWarningDays: Math.max(1, Math.round(safeNumber(source.settings?.expiryWarningDays, 90))),
      productCatalogVersion: cleanText(source.settings?.productCatalogVersion),
    },
  };
}

export function normalizeProduct(product) {
  const category = cleanText(product.category) || "相纸";
  let model = cleanText(product.model);
  let spec = cleanText(product.spec);
  if (category === "相纸" && model === "花边" && spec) {
    model = spec;
    spec = "";
  }
  return {
    id: cleanText(product.id),
    category,
    series: cleanText(product.series),
    model,
    spec,
    capacity: Math.max(1, Math.round(safeNumber(product.capacity, 1))),
    officialPrice: Math.max(0, safeNumber(product.officialPrice)),
    marketPrice: Math.max(0, safeNumber(product.marketPrice)),
    image: cleanText(product.image),
    createdAt: cleanText(product.createdAt),
  };
}

export function normalizeTransaction(tx) {
  const expiry = cleanText(tx.expiry);
  return {
    id: cleanText(tx.id),
    lotId: cleanText(tx.lotId),
    date: cleanText(tx.date),
    type: ["purchase", "sale", "use"].includes(tx.type) ? tx.type : "purchase",
    productId: cleanText(tx.productId),
    quantity: Math.max(0, safeNumber(tx.quantity)),
    unitPrice: Math.max(0, safeNumber(tx.unitPrice)),
    expiry: /^\d{4}-\d{2}/.test(expiry) ? expiry.slice(0, 7) : "",
    ...(!/^\d{4}-\d{2}/.test(expiry) && tx.expiryStatus === "unknown" ? { expiryStatus: "unknown" } : {}),
    region: cleanText(tx.region),
    counterparty: cleanText(tx.counterparty),
    originalTransfer: Boolean(tx.originalTransfer),
    notes: cleanText(tx.notes),
    createdAt: cleanText(tx.createdAt),
  };
}

export function batchKey(productId, lotId = "", expiry = "") {
  return `${productId}::${cleanText(lotId) || cleanText(expiry) || "无批次"}`;
}

export function typeLabel(type) {
  return ({ purchase: "购入", sale: "售出", use: "使用" })[type] || type;
}

function compareTransactions(a, b) {
  const byDate = String(a.date).localeCompare(String(b.date));
  if (byDate !== 0) return byDate;
  return String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
}

export function calculateInventory(stateInput, todayInput = new Date()) {
  const state = normalizeState(stateInput);
  const products = new Map(state.products.map((product) => [product.id, product]));
  const batches = new Map();
  const productStats = new Map();
  let purchaseTotal = 0;
  let saleTotal = 0;
  let useCost = 0;
  let trueProfit = 0;

  const getStats = (product) => {
    if (!productStats.has(product.id)) {
      productStats.set(product.id, {
        product,
        purchasedQty: 0,
        purchaseAmount: 0,
        soldQty: 0,
        saleAmount: 0,
        normalSoldQty: 0,
        normalSaleAmount: 0,
        usedQty: 0,
        stockQty: 0,
        costValue: 0,
        marketValue: 0,
        trueProfit: 0,
      });
    }
    return productStats.get(product.id);
  };

  for (const tx of state.transactions) {
    const product = products.get(tx.productId);
    if (!product || tx.quantity <= 0 || tx.type !== "purchase") continue;
    const key = batchKey(product.id, tx.lotId, tx.expiry);
    if (!batches.has(key)) {
      batches.set(key, {
        key,
        product,
        lotId: tx.lotId,
        expiry: tx.expiry,
        quantity: 0,
        purchaseAmount: 0,
        purchasedQty: 0,
        soldQty: 0,
        usedQty: 0,
      });
    }
    const batch = batches.get(key);
    const stats = getStats(product);
    const amount = tx.quantity * tx.unitPrice;
    batch.quantity += tx.quantity;
    batch.purchaseAmount += amount;
    batch.purchasedQty += tx.quantity;
    stats.purchasedQty += tx.quantity;
    stats.purchaseAmount += amount;
    purchaseTotal += amount;
  }

  for (const tx of [...state.transactions].sort(compareTransactions)) {
    const product = products.get(tx.productId);
    if (!product || tx.quantity <= 0 || tx.type === "purchase") continue;
    const key = batchKey(product.id, tx.lotId, tx.expiry);
    if (!batches.has(key)) {
      batches.set(key, {
        key, product, lotId: tx.lotId, expiry: tx.expiry, quantity: 0,
        purchaseAmount: 0, purchasedQty: 0, soldQty: 0, usedQty: 0,
      });
    }
    const batch = batches.get(key);
    const stats = getStats(product);
    const avgCost = batch.purchasedQty > 0 ? batch.purchaseAmount / batch.purchasedQty : 0;
    batch.quantity -= tx.quantity;

    if (tx.type === "sale") {
      const revenue = tx.quantity * tx.unitPrice;
      batch.soldQty += tx.quantity;
      stats.soldQty += tx.quantity;
      stats.saleAmount += revenue;
      saleTotal += revenue;
      if (!tx.originalTransfer) {
        const profit = revenue - tx.quantity * avgCost;
        stats.normalSoldQty += tx.quantity;
        stats.normalSaleAmount += revenue;
        stats.trueProfit += profit;
        trueProfit += profit;
      }
    } else if (tx.type === "use") {
      batch.usedQty += tx.quantity;
      stats.usedQty += tx.quantity;
      useCost += tx.quantity * avgCost;
    }
  }

  for (const batch of batches.values()) {
    const stats = getStats(batch.product);
    stats.stockQty += batch.quantity;
    batch.averageCost = batch.purchasedQty > 0 ? batch.purchaseAmount / batch.purchasedQty : 0;
    batch.costPool = Math.max(0, batch.quantity) * batch.averageCost;
    stats.costValue += batch.costPool;
    stats.marketValue += batch.quantity * batch.product.marketPrice;
    batch.sheetCount = batch.product.category === "相纸" ? batch.quantity * batch.product.capacity : 0;
  }

  for (const stats of productStats.values()) {
    stats.averagePurchasePrice = stats.purchasedQty ? stats.purchaseAmount / stats.purchasedQty : 0;
    stats.averageSalePrice = stats.normalSoldQty ? stats.normalSaleAmount / stats.normalSoldQty : 0;
  }

  const filmSheets = Object.fromEntries(FILM_SERIES.map((series) => [series, 0]));
  for (const batch of batches.values()) {
    if (batch.quantity > 0 && batch.product.category === "相纸" && FILM_SERIES.includes(batch.product.series)) {
      filmSheets[batch.product.series] += batch.sheetCount;
    }
  }

  const now = new Date(todayInput);
  now.setHours(0, 0, 0, 0);
  const warningMs = state.settings.expiryWarningDays * 86400000;
  const expiryMonthEnd = (value) => {
    const [year, month] = String(value).split("-").map(Number);
    return year && month ? new Date(year, month, 0, 23, 59, 59, 999) : null;
  };
  const expiring = [...batches.values()]
    .filter((batch) => {
      if (batch.product.category !== "相纸" || batch.quantity <= 0 || !batch.expiry) return false;
      const expiry = expiryMonthEnd(batch.expiry);
      if (!expiry) return false;
      const remaining = expiry.getTime() - now.getTime();
      return remaining <= warningMs;
    })
    .map((batch) => ({
      ...batch,
      daysLeft: Math.ceil((expiryMonthEnd(batch.expiry).getTime() - now.getTime()) / 86400000),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const activeBatches = [...batches.values()].filter((batch) => batch.quantity > 0);
  const negativeBatches = [...batches.values()].filter((batch) => batch.quantity < -1e-9);
  const inventoryMarketValue = activeBatches.reduce((sum, batch) => sum + batch.quantity * batch.product.marketPrice, 0);
  const inventoryOfficialValue = activeBatches.reduce((sum, batch) => sum + batch.quantity * batch.product.officialPrice, 0);
  const inventoryCostValue = activeBatches.reduce((sum, batch) => sum + batch.costPool, 0);

  return {
    purchaseTotal,
    saleTotal,
    useCost,
    trueProfit,
    inventoryMarketValue,
    inventoryOfficialValue,
    inventoryCostValue,
    activeBatches,
    negativeBatches,
    expiring,
    filmSheets,
    productStats: [...productStats.values()],
  };
}

export function availableQuantity(stateInput, productId, expiry = "") {
  const result = calculateInventory(stateInput);
  return result.activeBatches.find((batch) => batch.key === batchKey(productId, "", expiry))?.quantity || 0;
}

export function availableBatchQuantity(stateInput, productId, lotId = "", expiry = "") {
  const result = calculateInventory(stateInput);
  return result.activeBatches.find((batch) => batch.key === batchKey(productId, lotId, expiry))?.quantity || 0;
}

export function validateTransaction(stateInput, txInput) {
  const state = normalizeState(stateInput);
  const tx = normalizeTransaction(txInput);
  const product = state.products.find((item) => item.id === tx.productId);
  if (!product) return "请选择商品";
  if (!tx.date) return "请选择日期";
  if (tx.quantity <= 0) return "数量必须大于 0";
  const quantityStep = product.category === "相纸" ? 0.5 : 1;
  if (Math.abs(tx.quantity / quantityStep - Math.round(tx.quantity / quantityStep)) > 1e-9) {
    return product.category === "相纸" ? "相纸数量只能按整盒或 0.5 盒填写" : "相机数量只能按整台填写";
  }
  if (tx.type !== "purchase") {
    const available = availableBatchQuantity(state, tx.productId, tx.lotId, tx.expiry);
    if (tx.quantity > available) return `当前批次仅剩 ${available}，不能扣减 ${tx.quantity}`;
  }
  return "";
}

export function nextSerial(stateInput, category) {
  const state = normalizeState(stateInput);
  const prefix = category === "相纸" ? "film" : "cam";
  const max = state.transactions.reduce((value, item) => {
    const id = item.lotId || item.id;
    const match = new RegExp(`^${prefix}(\\d+)$`, "i").exec(id);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

export function transactionStatus(stateInput, txId) {
  const state = normalizeState(stateInput);
  const tx = state.transactions.find((item) => item.id === txId);
  if (!tx) return "";
  if (tx.type === "sale") return tx.originalTransfer ? "原价转让" : "已售";
  if (tx.type === "use") return "已用";
  const remaining = availableBatchQuantity(state, tx.productId, tx.lotId, tx.expiry);
  return remaining > 0 ? `库存 ${remaining}` : "已清空";
}

/** Missing film expiry is pending unless the owner explicitly marked it unknown. */
export function transactionExpiryStatus(state, tx) {
  const product = state.products.find(item => item.id === tx.productId);
  if (product?.category !== "相纸") return "not-applicable";
  if (tx.expiry) return "known";
  if (tx.expiryStatus === "unknown") return "unknown";
  const purchase = state.transactions.find(item => item.type === "purchase"
    && batchKey(item.productId, item.lotId, item.expiry) === batchKey(tx.productId, tx.lotId, tx.expiry));
  return purchase?.expiryStatus === "unknown" ? "unknown" : "pending";
}
export function matchesExpiryFilter(state, tx, filter) {
  if (!filter) return true;
  if (filter === "__pending") return transactionExpiryStatus(state, tx) === "pending";
  if (filter === "__unknown") return transactionExpiryStatus(state, tx) === "unknown";
  return tx.expiry === filter;
}
