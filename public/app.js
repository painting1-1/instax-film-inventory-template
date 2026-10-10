import {
  EMPTY_STATE,
  normalizePlatforms,
  matchesExpiryFilter,
  transactionExpiryStatus,
  calculateInventory,
  money,
  nextSerial,
  normalizeState,
  transactionStatus,
  typeLabel,
  validateTransaction,
} from "./core.mjs";
import { productImageSource, compressProductImage } from "./product-image.mjs";
import { filmShareItems, drawFilmShare } from "./inventory-share.mjs";
import { validateState } from "./state-validation.mjs";
import { PRODUCT_CATALOG, PRODUCT_CATALOG_VERSION } from "./product-catalog.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const dateToday = () => new Date().toISOString().slice(0, 10);
const formatDate = (value) => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${value}T00:00:00`)) : "无有效期";
const formatExpiry = (value) => {
  const match = /^(\d{4})-(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}年${match[2]}月` : "待补有效期";
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

let state = clone(EMPTY_STATE);
let storageMode = "checking";
let cloudConnected = false;
let cloudRevision = 0;
let refreshInProgress = false;
let pendingSave = false;
let syncConflict = false;
let saveQueue = Promise.resolve();
let inventoryCategory = "全部";
let libraryCategory = "全部", librarySeries = "";
let transactionType = "全部";
let filmDisplayUnit = localStorage.getItem("instant-inventory-film-unit") === "boxes" ? "boxes" : "sheets";
let toastTimer;
let editingProductId = null;
let editingTransactionId = null;
let sourcePurchaseId = null;
let currentUser = null;

function catalogKey(product) {
  const category = product?.category;
  const model = category === "相纸" && /^kitty$/i.test(product?.model || "") ? "手绘kitty" : product?.model;
  return [category, product?.series, model, product?.spec].map((value) => String(value || "").trim().toLowerCase()).join("|");
}

function applyProductCatalog(input) {
  const next = normalizeState(input);
  if (next.settings.productCatalogVersion === PRODUCT_CATALOG_VERSION) return { state: next, changed: false };
  const existingByKey = new Map(next.products.map((product) => [catalogKey(product), product]));
  const catalogKeys = new Set();
  const catalogProducts = PRODUCT_CATALOG.map((catalogProduct) => {
    const key = catalogKey(catalogProduct);
    catalogKeys.add(key);
    const existing = existingByKey.get(key);
    return { ...catalogProduct, id: existing?.id || catalogProduct.id, createdAt: existing?.createdAt || catalogProduct.createdAt };
  });
  next.products = [...catalogProducts, ...next.products.filter((product) => !catalogKeys.has(catalogKey(product)))];
  next.settings.productCatalogVersion = PRODUCT_CATALOG_VERSION;
  return { state: normalizeState(next), changed: true };
}

const refs = {
  syncDot: $("#syncDot"), syncTitle: $("#syncTitle"), syncDetail: $("#syncDetail"),
  productDialog: $("#productDialog"), productForm: $("#productForm"),
  transactionDialog: $("#transactionDialog"), transactionForm: $("#transactionForm"), transactionError: $("#transactionError"),
  dataDialog: $("#dataDialog"), expiryDialog: $("#expiryDialog"), expiryForm: $("#expiryForm"),
  toast: $("#toast"),
};

function toast(message) {
  clearTimeout(toastTimer);
  const activeDialog = [...document.querySelectorAll('dialog')].filter((dialog) => dialog.open).at(-1);
  if (activeDialog) {
    refs.toast.classList.remove('show');
    let notice = activeDialog.querySelector('.dialog-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'dialog-notice';
      notice.setAttribute('role', 'alert');
      const heading = activeDialog.querySelector('.dialog-head');
      if (heading) heading.after(notice);
      else activeDialog.prepend(notice);
    }
    notice.textContent = message;
    if (window.matchMedia?.('(max-width: 760px)').matches) {
      toastTimer = setTimeout(() => notice.remove(), 4000);
    } else {
      notice.scrollIntoView?.({ block: 'nearest' });
    }
    return;
  }
  refs.toast.textContent = message;
  refs.toast.classList.add("show");
  toastTimer = setTimeout(() => refs.toast.classList.remove("show"), 2400);
}

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('close', () => dialog.querySelector('.dialog-notice')?.remove());
});

function setSync(mode, detail = "") {
  storageMode = mode;
  refs.syncDot.className = `sync-dot ${mode === "cloud" ? "online" : ["local", "preview"].includes(mode) ? "local" : ""}`;
  refs.syncTitle.textContent = mode === "cloud" ? "云端已同步" : mode === "local" ? "离线保存" : mode === "preview" ? "空白预览" : "正在连接";
  refs.syncDetail.textContent = detail || (mode === "cloud" ? "电脑、手机自动同步" : mode === "local" ? "联网后自动恢复同步" : mode === "preview" ? "仅限本人访问" : "检查云端数据");
}

function updateAuthUi() {
  const signedIn = Boolean(currentUser);
  document.body.classList.toggle("read-only", !signedIn);
  $("#previewNotice").classList.toggle("hidden", signedIn);
  $("#lockButton").classList.toggle("hidden", !signedIn);
}

function showPreview() {
  cloudConnected = false;
  cloudRevision = 0;
  state = applyProductCatalog(EMPTY_STATE).state;
  setSync("preview");
  updateAuthUi();
  render();
}

function requireLogin() {
  $("#unlockDialog").showModal();
}

document.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-dialog]");
  if (!closeButton) return;
  closeButton.closest("dialog")?.close();
});

function localStateKey() {
  if (window.__DOM_SMOKE__) return "instant-inventory-state";
  return currentUser ? "instant-inventory-state:personal-owner" : "";
}

function readLocalState() {
  try {
    const key = localStateKey();
    const raw = key ? localStorage.getItem(key) : null;
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocalState(value = state) {
  const key = localStateKey();
  if (key) localStorage.setItem(key, JSON.stringify(value));
}

function mergeStates(remoteState, localState, preferLocal = true, preferLocalProducts = preferLocal) {
  const remote = normalizeState(remoteState);
  const local = normalizeState(localState);
  const mergeById = (remoteItems, localItems) => {
    const merged = new Map(remoteItems.map((item) => [item.id, item]));
    for (const item of localItems) if (preferLocal || !merged.has(item.id)) merged.set(item.id, item);
    return [...merged.values()];
  };
  return normalizeState({
    products: (() => {
      const merged = new Map(remote.products.map((item) => [item.id, item]));
      for (const item of local.products) if (preferLocalProducts || !merged.has(item.id)) merged.set(item.id, item);
      return [...merged.values()];
    })(),
    transactions: mergeById(remote.transactions, local.transactions),
    settings: { ...(preferLocal ? { ...remote.settings, ...local.settings } : { ...local.settings, ...remote.settings }), platforms: normalizePlatforms([...(remote.settings.platforms || []), ...(local.settings.platforms || [])]), purchasePlatforms: normalizePlatforms([...(remote.settings.purchasePlatforms || []), ...(local.settings.purchasePlatforms || [])]), salePlatforms: normalizePlatforms([...(remote.settings.salePlatforms || []), ...(local.settings.salePlatforms || [])]) },
  });
}

function countLocalDifferences(remoteState, localState) {
  const remoteProducts = new Set(remoteState.products.map((item) => item.id));
  const remoteTransactions = new Map(remoteState.transactions.map((item) => [item.id, JSON.stringify(item)]));
  return localState.products.filter((item) => !remoteProducts.has(item.id)).length
    + localState.transactions.filter((item) => remoteTransactions.get(item.id) !== JSON.stringify(item)).length;
}

async function putCloud(nextState, baseRevision = cloudRevision) {
  if (!currentUser) throw new Error("not signed in");
  return fetch("/api/state", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: nextState, baseRevision }),
  });
}

function readPending() {
  try { return JSON.parse(localStorage.getItem("instant-inventory-pending") || "null"); } catch { return null; }
}
function markConflict() {
  syncConflict = true;
  document.body.classList.add("sync-conflict");
  cloudConnected = false;
  $("#resolveConflict").classList.remove("hidden");
  setSync("local", "两台设备有不同修改，请先核对备份");
  toast("同步冲突：本机更改已保留，请点击“处理同步冲突”");
}
async function loadState() {
  if (!currentUser) return showPreview();
  const localState = readLocalState();
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) { currentUser = null; showPreview(); return requireLogin(); }
    if (!response.ok) throw new Error("cloud unavailable");
    const payload = await response.json();
    cloudRevision = Number(payload.revision || 0);
    const pending = readPending();
    if (pending) {
      state = normalizeState(pending.state);
      if (pending.baseRevision !== cloudRevision) { markConflict(); render(); return; }
      const saved = await putCloud(state, cloudRevision);
      if (saved.status === 409) { markConflict(); render(); return; }
      if (!saved.ok) throw new Error("pending save failed");
      const result = await saved.json();
      cloudRevision = result.revision;
      localStorage.removeItem("instant-inventory-pending");
    } else {
      state = payload.state?.products?.length || payload.state?.transactions?.length ? normalizeState(payload.state) : applyProductCatalog(payload.state || EMPTY_STATE).state;
    }
    cloudConnected = true;
    syncConflict = false;
    writeLocalState();
    setSync("cloud", payload.updatedAt ? `更新于 ${new Date(payload.updatedAt).toLocaleString("zh-CN")}` : "云端已连接，等待导入旧站备份");
  } catch {
    cloudConnected = false;
    state = normalizeState(readPending()?.state || localState || EMPTY_STATE);
    setSync("local", "云端暂时无法连接，更改保存在本机");
  }
  render();
}
function persist(message = "已保存") {
  if (!currentUser) return requireLogin();
  if (syncConflict) return toast("请先处理同步冲突，再继续修改");
  state = normalizeState(state);
  const snapshot = clone(state);
  writeLocalState();
  const previous = readPending();
  localStorage.setItem("instant-inventory-pending", JSON.stringify({ state: snapshot, baseRevision: previous?.baseRevision ?? cloudRevision }));
  render();
  if (!cloudConnected) { toast("已保存到本机，联网后会尝试同步"); return; }
  pendingSave = true;
  setSync("checking", "正在保存更改");
  saveQueue = saveQueue.then(async () => {
    if (syncConflict || !cloudConnected) return;
    const response = await putCloud(snapshot);
    if (response.status === 409) return markConflict();
    if (response.status === 401) { currentUser = null; showPreview(); requireLogin(); throw new Error("session expired"); }
    if (!response.ok) throw new Error("save failed");
    const result = await response.json();
    cloudRevision = result.revision;
    const pending = readPending();
    if (pending && JSON.stringify(pending.state) === JSON.stringify(snapshot)) localStorage.removeItem("instant-inventory-pending");
    else if (pending) localStorage.setItem("instant-inventory-pending", JSON.stringify({ ...pending, baseRevision: cloudRevision }));
    setSync("cloud", `刚刚更新 · ${new Date(result.updatedAt).toLocaleTimeString("zh-CN")}`);
    toast(message);
  }).catch(() => {
    cloudConnected = false;
    setSync("local", "云端暂时不可用，更改已保存在本机");
    toast("云端暂时不可用，更改已保存在本机");
  });
  saveQueue.finally(() => { pendingSave = Boolean(readPending()); });
}
$("#resolveConflict").addEventListener("click", async () => {
  const pending = readPending();
  if (pending) download(`片刻库存冲突备份_${dateToday()}.json`, JSON.stringify(pending.state, null, 2), "application/json");
  if (!window.confirm("本机修改已导出备份。是否载入云端最新数据？\n如需保留本机修改，请核对备份后通过导入恢复。")) return;
  localStorage.removeItem("instant-inventory-pending");
  syncConflict = false;
  document.body.classList.remove("sync-conflict");
  pendingSave = false;
  $("#resolveConflict").classList.add("hidden");
  await loadState();
});

function getProduct(productId) {
  return state.products.find((product) => product.id === productId);
}

const PRODUCT_IMAGE_ROOT = "/assets/products/";
const PRODUCT_IMAGE_MAP = {
  "mini|白边": "film-mini-classic.png",
  "mini|kitty": "film-mini-hello-kitty.png",
  "mini|双子星": "film-mini-kiki-lala.png",
  "mini|紫边": "film-mini-soft-lavender.png",
  "mini|蓝边": "film-mini-mermaid-tail.png",
  "mini|马卡龙": "film-mini-macaron.png",
  "mini|彩虹": "film-mini-rainbow.png",
  "mini|花花调色盘": "film-mini-spray-art.png",
  "mini|黑胶": "film-mini-photo-slide.png",
  "mini|流光": "film-mini-soft-glitter.png",
  "mini|浮光": "film-mini-pink-lemonade.png",
  "mini|银河": "film-mini-pastel-galaxy.png",
  "mini|波点": "film-mini-sprinkles.png",
  "sq|白边": "film-square-classic.png",
  "sq|黑边": "film-square-black.png",
  "sq|星空": "film-square-star.png",
  "sq|日落": "film-square-sunset.png",
  "sq|彩虹": "film-square-rainbow.png",
  "sq|黑白": "film-square-monochrome.png",
  "wide|白边": "film-wide-classic.png",
  "wide|黑边": "film-wide-black.png",
  "wide|鎏金": "film-wide-brushed-metallics.png",
};

function productImageName(product) {
  if (!product) return "";
  if (product.image) return product.image;
  const series = product.series.toLowerCase();
  const model = product.model.toLowerCase();
  const spec = product.spec.toLowerCase();
  if (product.category === "相纸") {
    const key = `${series}|${model}`;
    if (PRODUCT_IMAGE_MAP[key]) return PRODUCT_IMAGE_MAP[key];
    if (series === "mini") return "film-mini-classic.png";
    if (series === "sq") return "film-square-classic.png";
    if (series === "wide") return "film-wide-classic.png";
  }
  if (product.category === "相机") {
    if (model === "mini12") return spec.includes("紫") ? "camera-mini12-purple.png" : spec.includes("蓝") ? "camera-mini12-blue.png" : "camera-mini12-pink.png";
    if (model === "mini13") return "camera-mini13-pink.png";
    if (model === "mini9") return "camera-mini12-blue.png";
    if (model === "sq1") return spec.includes("橙") ? "camera-sq1-orange.png" : spec.includes("蓝") ? "camera-sq1-blue.png" : "camera-sq1-white.png";
    if (model === "sq6") return "camera-sq1-white.png";
    if (model === "wide400") return "camera-wide400-green.png";
  }
  return "";
}

function productVisual(product, extraClass = "") {
  const imageName = productImageName(product);
  const fallback = escapeHtml(product?.series?.slice(0, 4) || "ITEM");
  return `<span class="product-visual ${extraClass}">${imageName ? `<img src="${escapeHtml(productImageSource(imageName))}" alt="${escapeHtml(productName(product))}" loading="lazy" />` : `<b>${fallback}</b>`}</span>`;
}

function productName(product) {
  const model = product?.model?.toLowerCase() === "kitty" ? "Kitty" : product?.model;
  if (product?.category === "相机") return [model, product?.spec].filter(Boolean).join(" · ") || "未知相机";
  const filmVariant = product?.category === "相纸" && model === "白边" && product?.spec ? product.spec : model;
  return [product?.series, filmVariant].filter(Boolean).join(" · ") || "未知商品";
}

function productSubline(product) {
  if (product?.category === "相机") return "相机";
  if (product?.category === "相纸" && product?.model === "白边" && product?.spec) return "相纸";
  return [product?.category, product?.spec].filter(Boolean).join(" / ");
}

function renderSummary(result) {
  $("#inventoryValue").textContent = money(result.inventoryCostValue);
  $("#officialInventoryValue").textContent = money(result.inventoryOfficialValue);
  $("#purchaseTotal").textContent = money(result.purchaseTotal);
  $("#saleTotal").textContent = money(result.saleTotal);
  $("#trueProfit").textContent = money(result.trueProfit);
  $("#purchaseCount").textContent = `${state.transactions.filter((tx) => tx.type === "purchase").length} 笔购入流水`;
  $("#saleCount").textContent = `${state.transactions.filter((tx) => tx.type === "sale").length} 笔售出流水`;
  const filmBoxes = { Mini: 0, SQ: 0, Wide: 0 };
  for (const batch of result.activeBatches) {
    if (batch.product.category === "相纸" && filmBoxes[batch.product.series] !== undefined) filmBoxes[batch.product.series] += batch.quantity;
  }
  const filmValues = filmDisplayUnit === "boxes" ? filmBoxes : result.filmSheets;
  $("#miniSheets").textContent = numberText(filmValues.Mini);
  $("#sqSheets").textContent = numberText(filmValues.SQ);
  $("#wideSheets").textContent = numberText(filmValues.Wide);
  const totalFilmBoxes = result.activeBatches.filter((batch) => batch.product.category === "相纸").reduce((sum, batch) => sum + batch.quantity, 0);
  const totalFilmSheets = result.activeBatches.filter((batch) => batch.product.category === "相纸").reduce((sum, batch) => sum + batch.quantity * batch.product.capacity, 0);
  $("#totalFilmValue").textContent = numberText(filmDisplayUnit === "boxes" ? totalFilmBoxes : totalFilmSheets);
  $("#totalFilmUnit").textContent = filmDisplayUnit === "boxes" ? "盒" : "张";
  $$(".sheet-count small").forEach((element) => { element.textContent = filmDisplayUnit === "boxes" ? "盒" : "张"; });
  $("#filmUnitToggle").textContent = filmDisplayUnit === "boxes" ? "切换为张数" : "切换为盒数";
  $("#expirySetting").textContent = `${state.settings.expiryWarningDays} 天内`;

  const expiryList = $("#expiryList");
  if (!result.expiring.length) {
    expiryList.innerHTML = `<div class="empty-inline">当前没有需要提醒的相纸批次</div>`;
  } else {
    expiryList.innerHTML = result.expiring.map((batch) => {
      const dayText = batch.daysLeft < 0 ? `已过期 ${Math.abs(batch.daysLeft)} 天` : batch.daysLeft === 0 ? "今天到期" : `${batch.daysLeft} 天`;
      return `<div class="expiry-item">${productVisual(batch.product, "expiry-visual")}<div><strong>${escapeHtml(productName(batch.product))}</strong><small>${escapeHtml(batch.product.spec || batch.product.category)} · 剩余 ${numberText(batch.quantity)} 盒 · ${formatExpiry(batch.expiry)}</small></div><span class="expiry-days">${dayText}</span></div>`;
    }).join("");
  }
}

function numberText(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

function updateFilterOptions(result) {
  const current = {
    series: $("#seriesFilter").value,
    expiry: $("#expiryFilter").value,
    ledgerSeries: $("#ledgerSeries").value,
    ledgerExpiry: $("#ledgerExpiry").value,
  };
  const series = [...new Set(state.products.map((p) => p.series).filter(Boolean))].sort();
  const expiry = [...new Set(state.transactions.map((tx) => tx.expiry).filter(Boolean))].sort();
  for (const [id, values, selected, first] of [
    ["#seriesFilter", series, current.series, "全部系列"], ["#ledgerSeries", series, current.ledgerSeries, "全部系列"],
    ["#expiryFilter", expiry, current.expiry, "全部有效期"], ["#ledgerExpiry", expiry, current.ledgerExpiry, "全部有效期"],
  ]) {
    const select = $(id);
    const extra = id === "#ledgerExpiry" ? `<option value="__pending">待补有效期</option><option value="__unknown">有效期未知</option>` : "";
    select.innerHTML = `<option value="">${first}</option>${extra}${values.map((value) => `<option value="${escapeHtml(value)}">${id.includes("Expiry") || id.includes("expiry") ? formatExpiry(value) : escapeHtml(value)}</option>`).join("")}`;
    select.value = values.includes(selected) || (id === "#ledgerExpiry" && ["__pending", "__unknown"].includes(selected)) ? selected : "";
  }
}

function renderInventory(result) {
  const query = $("#inventorySearch").value.trim().toLowerCase();
  const series = $("#seriesFilter").value;
  const expiry = $("#expiryFilter").value;
  const filteredBatches = result.activeBatches.filter((batch) => {
    const haystack = [batch.product.series, batch.product.model, batch.product.spec, batch.expiry].join(" ").toLowerCase();
    return (inventoryCategory === "全部" || batch.product.category === inventoryCategory)
      && (!series || batch.product.series === series)
      && (!expiry || batch.expiry === expiry)
      && (!query || haystack.includes(query));
  });
  const grouped = new Map();
  for (const batch of filteredBatches) {
    const current = grouped.get(batch.product.id) || { product: batch.product, quantity: 0, costValue: 0 };
    current.quantity += batch.quantity;
    current.costValue += batch.quantity * batch.averageCost;
    grouped.set(batch.product.id, current);
  }
  const historicalPrices = new Map(result.productStats.map((stats) => [stats.product.id, stats.averagePurchasePrice]));
  const rows = [...grouped.values()].map((item) => ({
    ...item,
    averageCost: item.quantity ? item.costValue / item.quantity : 0,
    historicalAverage: historicalPrices.get(item.product.id) ?? 0,
  })).sort((a, b) => `${a.product.category}${a.product.series}${a.product.model}${a.product.spec}`.localeCompare(`${b.product.category}${b.product.series}${b.product.model}${b.product.spec}`, "zh-CN"));

  const activeFilters = [series, expiry].filter(Boolean).length;
  $("#inventoryFilterToggle").textContent = activeFilters ? `筛选 · ${activeFilters}` : "筛选";
  $("#inventoryFilterToggle").classList.toggle("has-filters", activeFilters > 0);
  $("#inventoryFilterClear").classList.toggle("hidden", !activeFilters);
  $("#inventoryResultCount").textContent = `${rows.length} 种商品`;
  const body = $("#inventoryBody");
  const empty = $("#inventoryEmpty");
  body.innerHTML = rows.map((item) => {
    const unit = item.product.category === "相纸" ? "盒" : "台";
    return `<tr>
      <td><div class="product-cell">${productVisual(item.product)}<div><strong>${escapeHtml(productName(item.product))}</strong><small>${escapeHtml(productSubline(item.product))}</small></div></div></td>
      <td class="num"><strong>${numberText(item.quantity)}</strong> ${unit}</td>
      <td class="num inventory-current-price">${money(item.averageCost)}</td>
      <td class="num inventory-history-price" title="所有历史购入总金额 ÷ 总购入数量">${money(item.historicalAverage)}<span class="mobile-price-unit">/${unit}</span></td>
      <td><button class="edit-product" data-edit-product="${escapeHtml(item.product.id)}">编辑</button></td>
    </tr>`;
  }).join("");
  empty.classList.toggle("show", rows.length === 0);
  $(".table-wrap").style.display = rows.length ? "block" : "none";
}

function renderLedger(result) {
  const query = $("#ledgerSearch").value.trim().toLowerCase();
  const category = $("#ledgerCategory").value;
  const series = $("#ledgerSeries").value;
  const expiry = $("#ledgerExpiry").value;
  const rows = [...state.transactions].sort((a, b) => `${b.date}${b.createdAt || b.id}`.localeCompare(`${a.date}${a.createdAt || a.id}`)).filter((tx) => {
    const product = getProduct(tx.productId) || {};
    const haystack = [tx.id, tx.lotId, product.series, product.model, product.spec, tx.counterparty, tx.region].join(" ").toLowerCase();
    return (transactionType === "全部" || tx.type === transactionType)
      && (!category || product.category === category)
      && (!series || product.series === series)
      && matchesExpiryFilter(state, tx, expiry)
      && (!query || haystack.includes(query));
  });

  const list = $("#ledgerList");
  updateLedgerToolbar(rows.length);
  if (!rows.length) {
    list.innerHTML = `<div class="ledger-empty">还没有符合条件的流水</div>`;
    return;
  }
  list.innerHTML = `<div class="ledger-row header"><span class="ledger-date">购入日期</span><span class="ledger-product">商品</span><span class="ledger-platform">平台</span><span class="ledger-batch">有效期</span><span class="ledger-type">类型</span><span class="ledger-quantity">数量</span><span class="ledger-unit-price">单价 / 状态</span><span></span></div>` + rows.map((tx) => {
    const product = getProduct(tx.productId) || {};
    const unitAmount = tx.type === "use" ? "—" : money(tx.unitPrice);
    const expiryState = transactionExpiryStatus(state, tx);
    const expiryCell = product.category === "相机"
      ? `<span class="expiry-na">不适用</span>`
      : expiryState === "unknown"
        ? `<span class="expiry-missing-text">有效期未知</span>`
        : tx.expiry
        ? formatExpiry(tx.expiry)
        : tx.type === "purchase"
          ? `<button class="expiry-missing" data-edit="${escapeHtml(tx.id)}">待补有效期</button>`
          : `<span class="expiry-missing-text">随购入批次待补</span>`;
    const hasStock = tx.type === "purchase" && result.activeBatches.some((batch) => batch.product.id === tx.productId && batch.lotId === tx.lotId && batch.expiry === tx.expiry);
    const batchActions = hasStock ? `<button class="record-action sale" data-create-type="sale" data-source="${escapeHtml(tx.id)}">售出</button><button class="record-action use" data-create-type="use" data-source="${escapeHtml(tx.id)}">使用</button>` : "";
    const isFilmUse = tx.type === "use" && product.category === "相纸";
    return `<div class="ledger-row" data-transaction-id="${escapeHtml(tx.id)}">
      <span class="ledger-date"><small class="ledger-date-label">${typeLabel(tx.type)}日期</small><strong>${formatDate(tx.date).replace(/年|月/g, "/").replace("日", "")}</strong></span>
      <span class="ledger-product">${productVisual(product, "ledger-visual")}<span><strong>${escapeHtml(productName(product))}</strong>${product.category !== "相纸" && productSubline(product) ? `<small class="ledger-meta">${escapeHtml(productSubline(product))}</small>` : ""}</span></span>
      <span class="ledger-platform">${tx.type !== "use" && tx.region ? platformMarkup(tx.region) : "—"}</span>
      <span class="ledger-batch">${expiryCell}</span>
      <span class="ledger-type"><b class="type-badge ${tx.type}">${typeLabel(tx.type)}</b>${tx.originalTransfer ? `<small class="transfer-mark">原价转让</small>` : ""}</span>
      <span class="ledger-quantity">${numberText(tx.quantity)} ${product.category === "相纸" ? "盒" : "台"}</span>
      <span class="ledger-unit-price"><strong>${unitAmount}</strong><small style="display:block;color:var(--muted);margin-top:3px">${escapeHtml(transactionStatus(state, tx.id))}</small></span>
      <span class="row-actions ledger-actions">${batchActions}<button class="edit-row" data-edit="${escapeHtml(tx.id)}" title="修改流水" aria-label="修改流水">✎</button><button class="delete-row" data-delete="${escapeHtml(tx.id)}" title="删除流水" aria-label="删除流水">×</button></span>
    </div>`;
  }).join("");
}

function updateLedgerToolbar(count) {
  const active = ["ledgerCategory", "ledgerSeries", "ledgerExpiry"].filter((id) => $("#" + id).value).length;
  $("#ledgerFilterToggle").textContent = active ? `筛选 · ${active}` : "筛选";
  $("#ledgerFilterToggle").classList.toggle("has-filters", active > 0);
  $("#ledgerFilterClear").classList.toggle("hidden", !active);
  $("#ledgerResultCount").textContent = `${count} 笔流水`;
}

function setLedgerFiltersOpen(open) {
  $("#ledgerFilterPanel").classList.toggle("filters-open", open);
  $("#ledgerFilterToggle").setAttribute("aria-expanded", String(open));
}
$("#ledgerFilterToggle").addEventListener("click", () => {
  setLedgerFiltersOpen(!$("#ledgerFilterPanel").classList.contains("filters-open"));
});
$("#ledgerFilterDone").addEventListener("click", () => {
  setLedgerFiltersOpen(false);
  $("#ledgerFilterToggle").focus();
});
for (const id of ["ledgerFilterReset", "ledgerFilterClear"]) $("#" + id).addEventListener("click", () => {
  for (const field of ["ledgerCategory", "ledgerSeries", "ledgerExpiry"]) $("#" + field).value = "";
  render();
});
function renderProductOptions(result) {
  const productSelect = refs.transactionForm.elements.productId;
  const categorySelect = refs.transactionForm.elements.productCategory;
  const seriesSelect = refs.transactionForm.elements.productSeries;
  const currentProduct = getProduct(productSelect.value);
  const currentCategory = currentProduct?.category || categorySelect.value;
  const currentSeries = currentProduct?.series || seriesSelect.value;
  categorySelect.value = ["相机", "相纸"].includes(currentCategory) ? currentCategory : "";
  const isFilm = categorySelect.value === "相纸";
  $("#transactionSeriesField").classList.toggle("hidden", !isFilm);
  const series = [...new Set(state.products.filter((product) => product.category === "相纸").map((product) => product.series).filter(Boolean))].sort((a, b) => ["Mini", "SQ", "Wide"].indexOf(a) - ["Mini", "SQ", "Wide"].indexOf(b));
  seriesSelect.innerHTML = `<option value="">再选择系列</option>${series.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  seriesSelect.value = isFilm && series.includes(currentSeries) ? currentSeries : "";
  const products = state.products.filter((product) => product.category === categorySelect.value && (!isFilm || product.series === seriesSelect.value));
  const prompt = !categorySelect.value ? "请先选择类别" : isFilm && !seriesSelect.value ? "请先选择系列" : "请选择具体商品";
  productSelect.innerHTML = `<option value="">${prompt}</option>` + products.map((product) => {
    const stock = result.activeBatches.filter((b) => b.product.id === product.id).reduce((sum, b) => sum + b.quantity, 0);
    const label = product.category === "相纸" ? [product.model, product.spec].filter(Boolean).join(" · ") : [product.model, product.spec].filter(Boolean).join(" · ");
    return `<option value="${escapeHtml(product.id)}">${escapeHtml(label)}（库存 ${numberText(stock)}）</option>`;
  }).join("");
  productSelect.value = currentProduct && products.some((product) => product.id === currentProduct.id) ? currentProduct.id : "";
}

function selectTransactionProduct(productId) {
  const product = getProduct(productId);
  refs.transactionForm.elements.productCategory.value = product?.category || "";
  refs.transactionForm.elements.productSeries.value = product?.category === "相纸" ? product.series : "";
  refs.transactionForm.elements.productId.value = product?.id || "";
  renderProductOptions(calculateInventory(transactionBaseState()));
  refs.transactionForm.elements.productId.value = product?.id || "";
}

function productIdentity(product) {
  const compact = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  const filmModel = product.category === '相纸' && product.model === '白边' && product.spec ? product.spec : product.model;
  return [product.category, product.category === '相纸' ? product.series : '', filmModel, product.category === '相纸' ? '' : product.spec].map(compact).join('|');
}
function renderProductLibrary(result) {
  const query = $("#librarySearch").value.trim().toLowerCase();
  const products = state.products.filter(product => (libraryCategory === '全部' || product.category === libraryCategory)
    && (!librarySeries || libraryCategory !== '相纸' || product.series.toLowerCase() === librarySeries.toLowerCase())
    && (!query || [product.series, product.model, product.spec, productName(product)].join(' ').toLowerCase().includes(query)));
  const stock = new Map();
  for (const batch of result.activeBatches) stock.set(batch.product.id, (stock.get(batch.product.id) || 0) + batch.quantity);
  const purchased = new Set(state.transactions.filter(tx => tx.type === 'purchase').map(tx => tx.productId));
  const counts = new Map();
  for (const product of state.products) counts.set(productIdentity(product), (counts.get(productIdentity(product)) || 0) + 1);
  const groups = new Map();
  for (const product of products) {
    const group = product.category === '相纸' ? `相纸 · ${product.series || '未分类'}` : product.category;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(product);
  }
  const order = ['相机', '相纸 · Mini', '相纸 · SQ', '相纸 · Wide'];
  const entries = [...groups].sort((a, b) => (order.includes(a[0]) ? order.indexOf(a[0]) : 99) - (order.includes(b[0]) ? order.indexOf(b[0]) : 99));
  $("#libraryResultCount").textContent = `共 ${state.products.length} 种商品 · 当前显示 ${products.length} 种`;
  $("#librarySeries").classList.toggle('hidden', libraryCategory !== '相纸');
  $("#productLibraryGroups").innerHTML = entries.map(([group, items]) => `<article class="library-group"><h3>${escapeHtml(group)} <small>${items.length} 种</small></h3><div class="library-product-grid">${items.sort((a,b) => productName(a).localeCompare(productName(b), 'zh-CN')).map(product => {
    const quantity = stock.get(product.id) || 0;
    const status = purchased.has(product.id) ? `剩余 ${numberText(quantity)} ${product.category === '相纸' ? '盒' : '台'}` : '尚未购入';
    return `<div class="library-product-card panel">${productVisual(product)}<div class="library-product-info"><strong>${escapeHtml(productName(product))}</strong><small>${status}${product.officialPrice ? ` · 官方价 ${money(product.officialPrice)}` : ''}</small>${counts.get(productIdentity(product)) > 1 ? '<small class="library-duplicate">存在同名商品</small>' : ''}</div><button type="button" class="edit-product" data-edit-product="${escapeHtml(product.id)}">编辑</button><button type="button" class="delete-product" data-delete-product="${escapeHtml(product.id)}">删除</button></div>`;
  }).join('')}</div></article>`).join('') || '<div class="empty-inline panel">没有符合条件的商品</div>';
}
$("#librarySearch").addEventListener('input', () => renderProductLibrary(calculateInventory(state)));
$("#libraryCategory").addEventListener('click', event => {
  const button = event.target.closest('button[data-value]'); if (!button) return;
  libraryCategory = button.dataset.value; librarySeries = '';
  $$('#libraryCategory button').forEach(item => item.classList.toggle('active', item === button));
  $$('#librarySeries button').forEach(item => item.classList.toggle('active', item.dataset.value === ''));
  renderProductLibrary(calculateInventory(state));
});
$("#librarySeries").addEventListener('click', event => {
  const button = event.target.closest('button[data-value]'); if (!button) return;
  librarySeries = button.dataset.value;
  $$('#librarySeries button').forEach(item => item.classList.toggle('active', item === button));
  renderProductLibrary(calculateInventory(state));
});
$("#libraryAddProduct").addEventListener('click', () => openProductDialog());
$("#productLibraryGroups").addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-delete-product]');
  if (deleteButton) {
    if (!currentUser) return requireLogin();
    if (syncConflict) return toast('请先处理同步冲突，再继续修改');
    const product = getProduct(deleteButton.dataset.deleteProduct);
    if (!product) return;
    if (state.transactions.some(tx => tx.productId === product.id)) return toast('此商品已有流水记录，不能删除，以免影响库存和利润');
    if (!window.confirm(`确认删除“${productName(product)}”？`)) return;
    state.products = state.products.filter(item => item.id !== product.id);
    persist('商品已删除');
    return;
  }
  const button = event.target.closest('[data-edit-product]');
  if (button) openProductDialog(button.dataset.editProduct);
});

function render() {
  const result = calculateInventory(state);
  renderSummary(result);
  updateFilterOptions(result);
  renderInventory(result);
  renderProductLibrary(result);
  renderLedger(result);
  renderProductOptions(result);
}

let productImageDraft = '', productImageRequest = 0;
function renderProductImagePreview() {
  const preview = $("#productImagePreview");
  preview.hidden = !productImageDraft;
  $("#productImageEmpty").hidden = Boolean(productImageDraft);
  $("#productImageRemove").classList.toggle("hidden", !productImageDraft);
  if (productImageDraft) preview.src = productImageSource(productImageDraft);
  else preview.removeAttribute('src');
}
$("#productImageInput").addEventListener('change', async () => {
  const file = $("#productImageInput").files?.[0];
  if (!file) return;
  const request = ++productImageRequest;
  $("#productSubmitButton").disabled = true;
  $("#productImageStatus").textContent = '正在处理图片……';
  try {
    const data = await compressProductImage(file);
    if (request !== productImageRequest || !refs.productDialog.open) return;
    productImageDraft = data;
    renderProductImagePreview();
    $("#productImageStatus").textContent = '图片已准备好，保存商品后会同步到其他设备。';
  } catch (error) {
    if (request === productImageRequest && refs.productDialog.open) $("#productImageStatus").textContent = error.message;
  } finally {
    if (request === productImageRequest) $("#productSubmitButton").disabled = false;
  }
});
$("#productImageRemove").addEventListener('click', () => {
  productImageRequest++; productImageDraft = '';
  $("#productImageInput").value = ''; $("#productSubmitButton").disabled = false;
  $("#productImageStatus").textContent = '保存商品后恢复默认图片。';
  renderProductImagePreview();
});
refs.productDialog.addEventListener('close', () => { productImageRequest++; });

function openProductDialog(productId = null) {
  if (syncConflict) return toast("请先处理同步冲突，再继续修改");

  editingProductId = productId;
  refs.productForm.reset();
  const product = productId ? getProduct(productId) : null;
  $("#productDialogTitle").textContent = product ? "编辑商品" : "添加商品";
  $("#productSubmitButton").textContent = product ? "保存修改" : "保存商品";
  const legacyFilmVariant = product?.category === "相纸" && product?.model === "白边" && product?.spec;
  refs.productForm.elements.category.value = product?.category || "";
  refs.productForm.elements.series.value = product?.category === "相纸" ? product.series || "" : "";
  refs.productForm.elements.model.value = legacyFilmVariant ? product.spec : product?.model || "";
  refs.productForm.elements.spec.value = legacyFilmVariant ? "" : product?.spec || "";
  refs.productForm.elements.capacity.value = product?.capacity || 10;
  refs.productForm.elements.officialPrice.value = product?.officialPrice || "";
  productImageDraft = product?.image || '';
  productImageRequest++;
  $("#productImageInput").value = '';
  $("#productSubmitButton").disabled = false;
  $("#productImageStatus").textContent = '支持 JPG、PNG、WebP，图片会自动压缩；保存商品后随库存同步。';
  renderProductImagePreview();
  updateProductFormFields();
  refs.productDialog.showModal();
}

function inferCameraSeries(model) {
  const value = String(model || "").trim().toLowerCase();
  if (value.startsWith("mini")) return "Mini";
  if (value.startsWith("sq")) return "SQ";
  if (value.startsWith("wide")) return "Wide";
  return "";
}

function updateProductFormFields() {
  const category = refs.productForm.elements.category.value;
  const hasCategory = Boolean(category);
  const isFilm = category === "相纸";
  const isCamera = category === "相机";
  $("#productSeriesField").classList.toggle("hidden", !isFilm);
  $("#productModelField").classList.toggle("hidden", !hasCategory);
  $("#productSpecField").classList.toggle("hidden", !hasCategory || isFilm);
  $("#productCapacityField").classList.toggle("hidden", !isFilm);
  refs.productForm.elements.series.required = isFilm;
  refs.productForm.elements.series.disabled = !isFilm;
  refs.productForm.elements.model.required = hasCategory;
  refs.productForm.elements.capacity.disabled = !isFilm;
  if (isFilm && !refs.productForm.elements.capacity.value) refs.productForm.elements.capacity.value = 10;
  if (!isFilm) refs.productForm.elements.capacity.value = 1;
  $("#productModelLabel").textContent = isFilm ? "具体型号" : isCamera ? "相机型号" : "具体型号";
  refs.productForm.elements.model.placeholder = isFilm ? "如：双白、Kitty、彩虹" : isCamera ? "如：Mini13、SQ1" : "请先选择类别";
  $("#productSpecLabel").textContent = isCamera ? "颜色（选填）" : "版本 / 规格（选填）";
  refs.productForm.elements.spec.placeholder = isCamera ? "如：粉色、白色" : "如：国际版、美版";
  $("#productFormHint").textContent = isFilm
    ? "相纸按“系列 · 具体型号”统一显示，例如 Mini · Kitty、Wide · 双白。"
    : isCamera
      ? "相机按“型号 · 颜色”统一显示，例如 SQ1 · 白色。"
      : "请先选择相纸或相机。";
}

function transactionBaseState() {
  return editingTransactionId
    ? { ...state, transactions: state.transactions.filter((tx) => tx.id !== editingTransactionId) }
    : state;
}

function openTransactionDialog(transactionId = null, actionType = null, purchaseId = null) {
  if (syncConflict) return toast("请先处理同步冲突，再继续修改");

  if (!state.products.length) {
    toast("请先添加一个商品");
    openProductDialog();
    return;
  }
  editingTransactionId = transactionId;
  sourcePurchaseId = purchaseId;
  refs.transactionForm.reset();
  refs.transactionForm.elements.productCategory.disabled = false;
  refs.transactionForm.elements.productSeries.disabled = false;
  refs.transactionForm.elements.productId.disabled = false;
  refs.transactionForm.elements.batchKey.disabled = false;
  refs.transactionError.textContent = "";
  const tx = transactionId ? state.transactions.find((item) => item.id === transactionId) : null;
  const sourcePurchase = purchaseId ? state.transactions.find((item) => item.id === purchaseId && item.type === "purchase") : null;
  const type = tx?.type || actionType || "purchase";
  $("#transactionDialogTitle").textContent = tx ? "修改流水" : type === "sale" ? "售出此批次" : type === "use" ? "记录使用" : "记一笔购入";
  $("#transactionSubmitButton").textContent = tx ? "保存修改" : type === "sale" ? "确认售出" : type === "use" ? "确认使用" : "保存购入";
  $(".type-picker", refs.transactionForm).classList.add("hidden");
  $$('input[name="type"]', refs.transactionForm).forEach((input) => { input.checked = input.value === type; });
  selectTransactionProduct(tx?.productId || sourcePurchase?.productId || "");
  refs.transactionForm.elements.date.value = tx?.date || dateToday();
  refs.transactionForm.elements.quantity.value = tx?.quantity ?? 1;
  refs.transactionForm.elements.unitPrice.value = tx?.unitPrice ?? 0;
  const preferredBatch = tx ? { lotId: tx.lotId, expiry: tx.expiry } : sourcePurchase ? { lotId: sourcePurchase.lotId, expiry: sourcePurchase.expiry } : null;
  updateTransactionFields(preferredBatch);
  if (tx) {
    if (type === "purchase") {
      refs.transactionForm.elements.lotId.value = tx.lotId || "";
      refs.transactionForm.elements.expiry.value = tx.expiry || "";
    }
    refs.transactionForm.elements.platformChoice.value = tx.region || "";
    syncPlatformPicker();
    refs.transactionForm.elements.counterparty.value = tx.counterparty || "";
    refs.transactionForm.elements.originalTransfer.checked = Boolean(tx.originalTransfer);
    refs.transactionForm.elements.notes.value = tx.notes || "";
  }
  if (sourcePurchase) {
    refs.transactionForm.elements.productCategory.disabled = true;
    refs.transactionForm.elements.productSeries.disabled = true;
    refs.transactionForm.elements.productId.disabled = true;
    refs.transactionForm.elements.batchKey.disabled = true;
  }
  refs.transactionDialog.showModal();
}

function setTransactionFieldVisible(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

function updateTransactionContext(batch = null) {
  const type = new FormData(refs.transactionForm).get("type") || "purchase";
  const product = getProduct(refs.transactionForm.elements.productId.value);
  const context = $("#transactionContext");
  if (type === "purchase" || !product) {
    context.classList.add("hidden");
    context.innerHTML = "";
    return;
  }
  const expiryText = product.category === "相机" ? "有效期不适用" : batch?.expiry ? `有效期 ${formatExpiry(batch.expiry)}` : "有效期待补";
  context.innerHTML = `${productVisual(product, "context-visual")}<span><strong>${escapeHtml(productName(product))}</strong><small>${escapeHtml(batch?.lotId || "历史批次")} · ${expiryText}</small></span>`;
  context.classList.remove("hidden");
}

function updateTransactionFields(preferredBatch = null) {
  renderPlatformChoices();
  const type = new FormData(refs.transactionForm).get("type") || "purchase";
  const product = getProduct(refs.transactionForm.elements.productId.value);
  const existing = editingTransactionId ? state.transactions.find((tx) => tx.id === editingTransactionId) : null;
  const isPurchase = type === "purchase";
  const isSale = type === "sale";
  $('#counterpartyField span').textContent = isSale ? '交易对象' : '店铺名称';

  const isCamera = product?.category === "相机";
  const isFilm = product?.category === "相纸";
  setTransactionFieldVisible("#transactionProductField", isPurchase);
  setTransactionFieldVisible("#transactionDateField", isPurchase);
  setTransactionFieldVisible("#lotIdField", isPurchase);
  setTransactionFieldVisible("#batchField", false);
  setTransactionFieldVisible("#expiryField", isPurchase && !isCamera);
  setTransactionFieldVisible("#quantityField", true);
  setTransactionFieldVisible("#unitPriceField", type !== "use");
  setTransactionFieldVisible("#regionField", type !== "use");
  setTransactionFieldVisible("#counterpartyField", type !== "use");
  setTransactionFieldVisible("#transferField", isSale);
  setTransactionFieldVisible("#notesField", isPurchase);
  refs.transactionForm.elements.quantity.min = isFilm ? "0.5" : "1";
  refs.transactionForm.elements.quantity.step = isFilm ? "0.5" : "1";
  $("#quantityHint").textContent = isFilm ? "相纸按整盒或 0.5 盒填写。" : "数量按整台填写。";
  if (isCamera) refs.transactionForm.elements.expiry.value = "";
  if (type !== "sale") refs.transactionForm.elements.originalTransfer.checked = false;
  if (type === "use") refs.transactionForm.elements.unitPrice.value = 0;
  if (isPurchase) {
    const keepLot = existing?.type === "purchase" && existing.productId === product?.id;
    refs.transactionForm.elements.lotId.value = keepLot ? existing.lotId : product ? nextSerial(state, product.category) : "";
    updateTransactionContext();
  } else {
    updateBatchOptions(preferredBatch);
  }
}

function updateBatchOptions(preferredBatch = null) {
  const productId = refs.transactionForm.elements.productId.value;
  const batches = calculateInventory(transactionBaseState()).activeBatches.filter((batch) => batch.product.id === productId);
  const select = refs.transactionForm.elements.batchKey;
  select.innerHTML = `<option value="">请选择有库存的批次</option>` + batches.map((batch) =>
    `<option value="${escapeHtml(batch.key)}">${escapeHtml(batch.lotId || "历史批次")} · ${batch.product.category === "相机" ? "有效期不适用" : formatExpiry(batch.expiry)} · 库存 ${numberText(batch.quantity)}</option>`
  ).join("");
  const preferred = preferredBatch && batches.find((batch) => batch.lotId === preferredBatch.lotId && batch.expiry === preferredBatch.expiry);
  const selected = preferred || (batches.length === 1 ? batches[0] : null);
  if (selected) {
    select.value = selected.key;
    refs.transactionForm.elements.expiry.value = selected.expiry || "";
  } else {
    refs.transactionForm.elements.expiry.value = "";
  }
  updateTransactionContext(selected);
}

refs.productForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return refs.productDialog.close();
  if (!refs.productForm.reportValidity()) return;
  const form = new FormData(refs.productForm);
  const category = form.get("category");
  const model = form.get("model");
  const nextProduct = {
    id: editingProductId || `prd-${crypto.randomUUID()}`,
    category,
    series: category === "相纸" ? form.get("series") : category === "相机" ? inferCameraSeries(model) : getProduct(editingProductId)?.series || "",
    model,
    spec: form.get("spec"),
    capacity: category === "相纸" ? Number(form.get("capacity")) : 1,
    officialPrice: Number(form.get("officialPrice")) || 0,
    marketPrice: editingProductId ? getProduct(editingProductId)?.marketPrice || 0 : 0,
    image: productImageDraft,
    createdAt: new Date().toISOString(),
  };
  if (!editingProductId && state.products.some(product => productIdentity(product) === productIdentity(nextProduct))) {
    return toast('商品库已有这个商品，请搜索后直接使用或编辑，避免重复添加');
  }
  const imageBytes = state.products.filter(item => item.id !== editingProductId).reduce((total, item) => total + (item.image?.startsWith('data:') ? item.image.length : 0), 0) + (nextProduct.image.startsWith('data:') ? nextProduct.image.length : 0);
  if (imageBytes > 1200000) return toast('商品图片总量较大，请先恢复不需要的自定义图片再保存');
  if (editingProductId) state.products = state.products.map((item) => item.id === editingProductId ? nextProduct : item);
  else state.products.push(nextProduct);
  refs.productDialog.close();
  persist(editingProductId ? "商品资料已更新" : "商品已添加");
  editingProductId = null;
});

refs.productForm.elements.category.addEventListener("change", () => {
  refs.productForm.elements.series.value = "";
  refs.productForm.elements.model.value = "";
  refs.productForm.elements.spec.value = "";
  updateProductFormFields();
});

refs.transactionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return refs.transactionDialog.close();
  if (!refs.transactionForm.reportValidity()) return;
  const form = new FormData(refs.transactionForm);
  const type = form.get("type");
  const baseState = transactionBaseState();
  const sourcePurchase = sourcePurchaseId ? state.transactions.find((item) => item.id === sourcePurchaseId) : null;
  const productId = sourcePurchase?.productId || form.get("productId");
  const product = getProduct(productId);
  const selectedBatch = type === "purchase" ? null : calculateInventory(baseState).activeBatches.find((batch) => sourcePurchase
    ? batch.product.id === sourcePurchase.productId && batch.lotId === sourcePurchase.lotId && batch.expiry === sourcePurchase.expiry
    : batch.key === form.get("batchKey"));
  const existing = editingTransactionId ? state.transactions.find((item) => item.id === editingTransactionId) : null;
  const tx = {
    id: existing?.id || `rec-${crypto.randomUUID()}`,
    lotId: type === "purchase" ? form.get("lotId") : selectedBatch?.lotId || "",
    type,
    productId,
    date: form.get("date"),
    expiry: type === "purchase" && product?.category !== "相机" ? form.get("expiry") : selectedBatch?.expiry || "",
    quantity: Number(form.get("quantity")),
    unitPrice: Number(form.get("unitPrice")) || 0,
    region: type === "use" ? "" : selectedPlatform(form),
    counterparty: form.get("counterparty"),
    originalTransfer: form.get("originalTransfer") === "on",
    notes: form.get("notes"),
    expiryStatus: existing?.expiryStatus === "unknown" && !form.get("expiry") ? "unknown" : undefined,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const error = validateTransaction(baseState, tx);
  if (error) {
    refs.transactionError.textContent = error;
    return;
  }
  const recalculated = calculateInventory({ ...baseState, transactions: [...baseState.transactions, tx] });
  if (recalculated.negativeBatches.length) {
    refs.transactionError.textContent = "修改后会导致已有售出或使用流水超出库存，请增加购入数量或先调整后续流水";
    return;
  }
  if (editingTransactionId) {
    state.transactions = state.transactions.map((item) => {
      if (item.id === editingTransactionId) return tx;
      const belongsToEditedPurchase = existing?.type === "purchase" && item.type !== "purchase" && item.productId === existing.productId && item.lotId === existing.lotId;
      return belongsToEditedPurchase ? { ...item, expiry: tx.expiry, expiryStatus: tx.expiryStatus } : item;
    });
  } else state.transactions.push(tx);
  if (type !== 'use') {
    const key = type === 'sale' ? 'salePlatforms' : 'purchasePlatforms';
    state.settings[key] = normalizePlatforms([...(state.settings[key] || []), tx.region]);
  }
  refs.transactionDialog.close();
  persist(editingTransactionId ? `流水 ${tx.lotId || tx.id} 已修改` : `${typeLabel(tx.type)}流水 ${tx.lotId || tx.id} 已保存`);
  editingTransactionId = null;
  sourcePurchaseId = null;
});

$$('input[name="type"]', refs.transactionForm).forEach((input) => input.addEventListener("change", updateTransactionFields));
refs.transactionForm.elements.productId.addEventListener("change", () => {
  const product = getProduct(refs.transactionForm.elements.productId.value);
  if (product?.category !== "相纸") refs.transactionForm.elements.expiry.value = "";
  updateTransactionFields();
});
refs.transactionForm.elements.productCategory.addEventListener("change", () => {
  refs.transactionForm.elements.productSeries.value = "";
  refs.transactionForm.elements.productId.value = "";
  renderProductOptions(calculateInventory(transactionBaseState()));
  updateTransactionFields();
});
refs.transactionForm.elements.productSeries.addEventListener("change", () => {
  refs.transactionForm.elements.productId.value = "";
  renderProductOptions(calculateInventory(transactionBaseState()));
  updateTransactionFields();
});
refs.transactionForm.elements.batchKey.addEventListener("change", () => {
  const batch = calculateInventory(transactionBaseState()).activeBatches.find((item) => item.key === refs.transactionForm.elements.batchKey.value);
  refs.transactionForm.elements.expiry.value = batch?.expiry || "";
  updateTransactionContext(batch);
});

$("#ledgerList").addEventListener("click", (event) => {
  const createButton = event.target.closest("[data-create-type]");
  if (createButton) {
    openTransactionDialog(null, createButton.dataset.createType, createButton.dataset.source);
    return;
  }
  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    openTransactionDialog(editButton.dataset.edit);
    return;
  }
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const id = button.dataset.delete;
  if (!window.confirm(`删除流水 ${id}？删除后库存和金额会自动重新计算。`)) return;
  state.transactions = state.transactions.filter((tx) => tx.id !== id);
  persist(`流水 ${id} 已删除`);
});

$("#addProductButton").addEventListener("click", () => openProductDialog());
for (const id of ["addTransactionButton", "emptyAddButton"]) $("#" + id).addEventListener("click", () => openTransactionDialog());
$("#inventoryBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-product]");
  if (button) openProductDialog(button.dataset.editProduct);
});
$("#dataButton").addEventListener("click", () => refs.dataDialog.showModal());
$("#expirySetting").addEventListener("click", () => {
  refs.expiryForm.elements.days.value = state.settings.expiryWarningDays;
  refs.expiryDialog.showModal();
});

refs.expiryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return refs.expiryDialog.close();
  if (!refs.expiryForm.reportValidity()) return;
  state.settings.expiryWarningDays = Number(refs.expiryForm.elements.days.value);
  refs.expiryDialog.close();
  persist("提醒范围已更新");
});

for (const [selector, setter] of [["#inventoryCategory", (value) => inventoryCategory = value], ["#transactionType", (value) => transactionType = value]]) {
  $(selector).addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    $$(`${selector} button`).forEach((item) => item.classList.toggle("active", item === button));
    setter(button.dataset.value);
    render();
  });
}

for (const id of ["inventorySearch", "seriesFilter", "expiryFilter", "ledgerSearch", "ledgerCategory", "ledgerSeries", "ledgerExpiry"]) {
  $("#" + id).addEventListener(id.includes("Search") ? "input" : "change", render);
}

$("#filmUnitToggle").addEventListener("click", () => {
  filmDisplayUnit = filmDisplayUnit === "boxes" ? "sheets" : "boxes";
  localStorage.setItem("instant-inventory-film-unit", filmDisplayUnit);
  renderSummary(calculateInventory(state));
});
function setInventoryFiltersOpen(open) {
  $("#inventoryFilterPanel").classList.toggle("filters-open", open);
  $("#inventoryFilterToggle").setAttribute("aria-expanded", String(open));
}
$("#inventoryFilterToggle").addEventListener("click", () => {
  setInventoryFiltersOpen(!$("#inventoryFilterPanel").classList.contains("filters-open"));
});
$("#inventoryFilterDone").addEventListener("click", () => {
  setInventoryFiltersOpen(false);
  $("#inventoryFilterToggle").focus();
});
for (const id of ["inventoryFilterReset", "inventoryFilterClear"]) $("#" + id).addEventListener("click", () => {
  $("#seriesFilter").value = ""; $("#expiryFilter").value = "";
  render();
});
$("#clearFilters").addEventListener("click", () => {
  $("#inventorySearch").value = ""; $("#seriesFilter").value = ""; $("#expiryFilter").value = "";
  render();
});

function download(name, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("#exportJson").addEventListener("click", () => {
  download(`片刻库存备份_${dateToday()}.json`, JSON.stringify(state, null, 2), "application/json");
  toast("完整备份已导出");
});

$("#exportCsv").addEventListener("click", () => {
  const cells = (values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
  const header = ["流水号", "日期", "类型", "类别", "系列", "型号", "颜色/规格", "数量", "单价", "金额", "有效期", "平台", "店铺名称/交易对象", "朋友原价转让", "状态", "备注"];
  const lines = state.transactions.map((tx) => {
    const product = getProduct(tx.productId) || {};
    return cells([tx.lotId || tx.id, tx.date, typeLabel(tx.type), product.category, product.series, product.model, product.spec, tx.quantity, tx.unitPrice, tx.quantity * tx.unitPrice, transactionExpiryStatus(state, tx) === "unknown" ? "有效期未知" : tx.expiry, tx.region, tx.counterparty, tx.originalTransfer ? "是" : "否", transactionStatus(state, tx.id), tx.notes]);
  });
  download(`拍立得流水_${dateToday()}.csv`, `\ufeff${cells(header)}\n${lines.join("\n")}`, "text/csv;charset=utf-8");
  toast("流水 CSV 已导出");
});

$("#importJson").addEventListener("change", async (event) => {
  if (syncConflict) { event.target.value = ""; return toast("请先处理同步冲突，再导入备份"); }
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.transactions)) throw new Error();
    const incoming = validateState(parsed);
    download(`片刻库存导入前备份_${dateToday()}.json`, JSON.stringify(state, null, 2), "application/json");
    state = incoming;
    refs.dataDialog.close();
    persist("备份已导入并重新计算");
  } catch {
    toast("导入失败：请选择本站导出的 JSON 备份");
  } finally {
    event.target.value = "";
  }
});

$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
function setActiveSection(sectionId) {
  $$('.nav-link').forEach((item) => {
    const active = item.dataset.section === sectionId;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}
$$('.nav-link').forEach((link) => link.addEventListener("click", () => {
  setActiveSection(link.dataset.section);
  $(".sidebar").classList.remove("open");
}));

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  setActiveSection(visible.target.id);
}, { rootMargin: "-20% 0px -60%", threshold: [0, .2, .5] });
$$('.page-section').forEach((section) => observer.observe(section));

async function refreshFromCloud() {
  if (!currentUser || refreshInProgress || syncConflict || document.visibilityState === "hidden") return;
  refreshInProgress = true;
  try {
    if (!cloudConnected) return await loadState();
    if (pendingSave) return;
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) { currentUser = null; showPreview(); return requireLogin(); }
    if (!response.ok) return;
    const payload = await response.json();
    const revision = Number(payload.revision || 0);
    if (payload.state && revision > cloudRevision) {
      state = normalizeState(payload.state);
      cloudRevision = revision;
      writeLocalState();
      render();
      setSync("cloud", "已载入其他设备的最新更改");
    }
    } catch { setSync("local", "云端暂时无法连接，请检查网络"); } finally {
    refreshInProgress = false;
  }
}

document.addEventListener("visibilitychange", refreshFromCloud);
window.addEventListener("focus", refreshFromCloud);

async function startAuthentication() {
  showPreview();
  if (window.__DOM_SMOKE__) {
    currentUser = { uid: "owner" };
    updateAuthUi();
    return loadState();
  }
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (response.ok) {
      currentUser = await response.json();
      updateAuthUi();
      await loadState();
    } else if (response.status === 401) requireLogin();
    else setSync("preview", "云端未配置或暂时无法连接");
  } catch { setSync("preview", "云端暂时无法连接，请检查网络"); }
}
$("#unlockButton").addEventListener("click", requireLogin);
$("#unlockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#unlockSubmit");
  button.disabled = true;
  $("#unlockError").textContent = "";
  try {
    const response = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: event.target.elements.passphrase.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "验证失败");
    event.target.reset();
    $("#unlockDialog").close();
    currentUser = result;
    updateAuthUi();
    await loadState();
  } catch (error) { $("#unlockError").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#lockButton").addEventListener("click", async () => {
  await saveQueue;
  if (readPending()) return toast("还有未同步的更改，请先同步或导出备份");
  const response = await fetch("/api/logout", { method: "POST" });
  if (!response.ok) return toast("锁定失败，请重试");
  currentUser = null;
  localStorage.removeItem("instant-inventory-state:personal-owner");
  localStorage.removeItem("instant-inventory-pending");
  showPreview();
});
startAuthentication();
if (!window.__DOM_SMOKE__) setInterval(refreshFromCloud, 20000);

// Share images are rendered on this device; they do not modify cloud inventory.
let shareItems = [], shareBlob = null, shareImageUrl = '', shareRenderId = 0;
async function renderInventoryShare() {
  const requestId = ++shareRenderId;
  $("#shareDownload").disabled = true; $("#shareNative").disabled = true;
  $("#inventorySharePreview").hidden = true;
  shareBlob = null;
  $("#inventoryShareStatus").textContent = shareItems.length ? "正在生成图片……" : "这个系列目前没有剩余相纸。";
  if (!shareItems.length) return;
  try {
    const series = $("#shareFilmSeries").value;
    const result = await drawFilmShare(shareItems, {
      title: series ? `我的 ${series} 相纸库存` : "我的相纸库存",
      name: productName,
      imageSource: product => productImageSource(productImageName(product)),
    });
    if (requestId !== shareRenderId || !$("#inventoryShareDialog").open) return;
    if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
    shareBlob = result.blob; shareImageUrl = URL.createObjectURL(shareBlob);
    $("#inventorySharePreview").src = shareImageUrl;
    $("#inventorySharePreview").hidden = false;
    $("#inventoryShareStatus").textContent = `${shareItems.length} 种相纸 · 完整长图${result.missing ? ' · 部分商品图片未能载入，已使用占位图' : ''}`;
    $("#shareDownload").disabled = false; $("#shareNative").disabled = false;
  } catch (error) {
    if (requestId === shareRenderId) $("#inventoryShareStatus").textContent = error.message || "图片生成失败，请重试。";
  }
}
function prepareInventoryShare() {
  shareItems = filmShareItems(calculateInventory(state).activeBatches, $("#shareFilmSeries").value);
  renderInventoryShare();
}
$("#inventoryShareButton").addEventListener("click", () => {
  $("#shareFilmSeries").value = $("#seriesFilter").value;
  $("#inventoryShareDialog").showModal();
  prepareInventoryShare();
});
$("#shareFilmSeries").addEventListener("change", prepareInventoryShare);
$("#inventoryShareDialog").addEventListener("close", () => {
  shareRenderId++; shareBlob = null;
  if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
  shareImageUrl = ''; $("#inventorySharePreview").removeAttribute("src");
});
function shareImageFile() {
  return new File([shareBlob], `相纸库存-${$("#shareFilmSeries").value || '全部'}.png`, { type: 'image/png' });
}
async function openImageShare() {
  const file = shareImageFile();
  if (!navigator.canShare?.({ files: [file] })) return false;
  try { await navigator.share({ files: [file], title: '我的相纸库存' }); }
  catch (error) { if (error.name !== 'AbortError') toast("系统分享未完成，可长按预览图保存。"); }
  return true;
}
$("#shareDownload").addEventListener("click", async () => {
  if (!shareBlob) return;
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (phone) {
    if (await openImageShare()) return;
    toast("请长按预览图片，选择存储图像或保存到相册。");
    return;
  }
  const link = document.createElement("a");
  link.href = shareImageUrl; link.download = shareImageFile().name; link.click();
});
$("#shareNative").addEventListener("click", async () => {
  if (!shareBlob) return;
  if (!await openImageShare()) toast("手机可长按预览图保存；电脑请点击保存图片。");
});


const PLATFORM_BRANDS = [
  [/小红书|xiaohongshu|\\bxhs\\b|rednote/i, '/assets/platform-xiaohongshu.svg', '#ff2442'],
  [/淘宝|taobao/i, 'https://www.taobao.com/favicon.ico', '#ff5000'],
  [/京东|\bjd\b/i, 'https://www.jd.com/favicon.ico', '#e2231a'],
  [/拼多多|pdd|pinduoduo/i, '/assets/platform-pinduoduo.svg', '#e02e24'],
  [/抖音|douyin/i, 'https://www.douyin.com/favicon.ico', '#222'],
  [/闲鱼|xianyu|goofish/i, 'https://www.goofish.com/favicon.ico', '#e0b800'],
  [/shopee/i, 'https://shopee.sg/favicon.ico', '#ee4d2d'],
  [/lazada/i, 'https://www.lazada.sg/favicon.ico', '#6938ef'],
  [/amazon|亚马逊/i, 'https://www.amazon.com/favicon.ico', '#d88b00'],
  [/rakuten|乐天/i, 'https://www.rakuten.co.jp/favicon.ico', '#bf0000'],
  [/mercari|煤炉/i, 'https://www.mercari.com/favicon.ico', '#e84545'],
];
function platformMarkup(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const brand = PLATFORM_BRANDS.find(([match]) => match.test(text));
  const fallback = escapeHtml(Array.from(text)[0].toUpperCase());
  return `<span class="platform-name"><span class="platform-logo" aria-hidden="true" style="--platform-color:${brand?.[2] || '#6f8277'}">${fallback}${brand ? `<img src="${brand[1]}" alt="" referrerpolicy="no-referrer" loading="lazy" />` : ''}</span><span>${escapeHtml(text)}</span></span>`;
}
document.addEventListener('error', event => {
  if (event.target.matches?.('.platform-logo img')) event.target.remove();
}, true);
const platformStyles = document.createElement('style');
platformStyles.textContent = `
.platform-name { display:inline-flex; align-items:center; gap:7px; vertical-align:middle; min-width:0; }
.platform-logo { position:relative; display:inline-grid; place-items:center; width:20px; height:20px; flex:none; border-radius:5px; background:var(--platform-color); color:white; font-size:11px; line-height:1; overflow:hidden; font-weight:700; }
.platform-logo img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:white; }
.platform-picker { position:relative; }
.platform-picker summary { cursor:pointer; list-style:none; display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:42px; padding:10px 11px; border:1px solid #dddcd4; border-radius:10px; background:#fffefb; font-size:14px; }
.platform-picker summary::-webkit-details-marker { display:none; }
.platform-picker summary::after { content:'⌄'; color:#6f7c76; }
.platform-picker summary:focus-visible, .platform-option:focus-visible { outline:2px solid #52796a; outline-offset:2px; }
.platform-options { position:absolute; top:calc(100% + 5px); left:0; right:0; z-index:10; max-height:220px; overflow:auto; padding:5px; background:#fffefb; border:1px solid #dddcd4; border-radius:10px; box-shadow:0 8px 24px #243c2820; }
.platform-option { display:block; width:100%; border:0; border-radius:6px; padding:9px; background:transparent; color:inherit; text-align:left; cursor:pointer; font-size:14px; }
.platform-option:hover, .platform-option[aria-pressed="true"] { background:#eaf0e9; }
.platform-breakdown b .platform-name { display:inline-flex; padding:0; font-size:inherit; }
.platform-breakdown b .platform-logo { display:inline-grid; padding:0; }
`;
document.head.append(platformStyles);
function syncPlatformPicker() {
  const select = refs.transactionForm.elements.platformChoice;
  const picker = document.querySelector('#platformPicker');
  if (!picker) return;
  picker.querySelector('summary').innerHTML = platformMarkup(select.value) || '选择平台';
  picker.querySelectorAll('[data-platform]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.platform === select.value)));
}
function buildPlatformPicker(choices) {
  const select = refs.transactionForm.elements.platformChoice;
  let picker = document.querySelector('#platformPicker');
  if (!picker) {
    picker = document.createElement('details');
    picker.id = 'platformPicker';
    picker.className = 'platform-picker';
    picker.innerHTML = '<summary aria-label="选择平台"></summary><div class="platform-options" role="group" aria-label="平台选项"></div>';
    select.after(picker);
    select.hidden = true;
    picker.addEventListener('click', event => {
      const option = event.target.closest('[data-platform]');
      if (!option) return;
      event.preventDefault();
      select.value = option.dataset.platform;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      picker.open = false;
      picker.querySelector('summary').focus();
    });
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape') { picker.open = false; picker.querySelector('summary').focus(); }
    });
    document.addEventListener('click', event => { if (!picker.contains(event.target)) picker.open = false; });
  }
  picker.open = false;
  picker.querySelector('.platform-options').innerHTML = [''].concat(choices).map(name => `<button type="button" class="platform-option" data-platform="${escapeHtml(name)}">${platformMarkup(name) || '选择平台'}</button>`).join('');
  syncPlatformPicker();
}

function platformChoices(type = new FormData(refs.transactionForm).get('type') || 'purchase') {
  const key = type === 'sale' ? 'salePlatforms' : 'purchasePlatforms';
  return normalizePlatforms([
    ...(type === 'sale' ? ['闲鱼'] : ['淘宝', '京东', '拼多多', '抖音']),
    ...(state.settings[key] || []),
    ...state.transactions.filter(tx => tx.type === type).map(tx => tx.region),
  ]);
}
function renderPlatformChoices() {
  const select = refs.transactionForm.elements.platformChoice;
  const previous = select.value;
  const choices = platformChoices();
  select.innerHTML = '<option value="">选择平台</option>' + choices.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  select.value = choices.includes(previous) ? previous : '';
  buildPlatformPicker(choices);
}
function selectedPlatform(form) {
  const typed = String(form.get('region') || '').trim();
  const value = typed || String(form.get('platformChoice') || '').trim();
  return platformChoices().find(name => name.toLocaleLowerCase() === value.toLocaleLowerCase()) || value;
}
refs.transactionForm.elements.platformChoice.addEventListener('change', () => {
  refs.transactionForm.elements.region.value = '';
  syncPlatformPicker();
});
refs.transactionForm.elements.region.addEventListener('input', () => {
  if (refs.transactionForm.elements.region.value.trim()) refs.transactionForm.elements.platformChoice.value = '';
  syncPlatformPicker();
});
