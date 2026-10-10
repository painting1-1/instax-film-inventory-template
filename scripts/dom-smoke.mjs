import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
const { window } = parseHTML(html);
const memory = new Map();

class LocalStorage {
  getItem(key) { return memory.has(key) ? memory.get(key) : null; }
  setItem(key, value) { memory.set(key, String(value)); }
  removeItem(key) { memory.delete(key); }
  clear() { memory.clear(); }
}

class FormDataMock {
  constructor(form) {
    this.values = new Map();
    for (const control of form.querySelectorAll("[name]")) {
      if ((control.type === "radio" || control.type === "checkbox") && !control.checked) continue;
      this.values.set(control.name, control.type === "checkbox" ? "on" : control.value);
    }
  }
  get(name) { return this.values.get(name) ?? null; }
}

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let cloudReadCount = 0;
let failWrites = false;
let remoteRevision = 1;
let legacyClaimCount = 0;
const mockCloudResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: new LocalStorage(),
  FormData: FormDataMock,
  IntersectionObserver: IntersectionObserverMock,
  fetch: async (path, options = {}) => {
    if (path === "/api/claim-owner") { legacyClaimCount++; return mockCloudResponse({ error: "public visit" }, 403); }
    if (path === "/api/state" && options.method === "PUT" && failWrites) throw new Error("offline");
    if (path === "/api/state" && options.method === "PUT") return mockCloudResponse({ revision: 2, updatedAt: new Date().toISOString() });
    if (path === "/api/state") {
      cloudReadCount++;
      return mockCloudResponse({ state: { products: [], transactions: [], settings: { expiryWarningDays: 180 } }, revision: remoteRevision, updatedAt: new Date().toISOString() });
    }
    return mockCloudResponse({ error: "local smoke" }, 503);
  },
});
Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
  configurable: true,
  get() { return this._smokeValue ?? this.querySelector("option")?.getAttribute("value") ?? this.querySelector("option")?.textContent ?? ""; },
  set(value) { this._smokeValue = String(value); },
});
window.confirm = () => true;
window.__DOM_SMOKE__ = true;
globalThis.requestAnimationFrame = (callback) => callback();
globalThis.localStorage.setItem("instant-inventory-state", JSON.stringify({ products: [], transactions: [], settings: { expiryWarningDays: 180 } }));
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
}
for (const form of document.querySelectorAll("form")) {
  form.reportValidity = () => true;
  form.reset = () => {};
  Object.defineProperty(form, "elements", {
    value: new Proxy({}, { get: (_, name) => form.querySelector(`[name="${String(name)}"]`) }),
  });
}

await import(new URL(`../dist/client/app.js?smoke=${Date.now()}`, import.meta.url));
await new Promise((resolve) => setTimeout(resolve, 20));
if (cloudReadCount !== 1 || legacyClaimCount !== 0 || document.querySelector("#syncTitle").textContent !== "云端已同步") throw new Error("公开网站的老用户在新设备登录后没有直接读取云端库存");

const migratedCatalog = JSON.parse(localStorage.getItem("instant-inventory-state") || "null");
if (migratedCatalog && migratedCatalog.products.filter((product) => product.image?.startsWith("catalog/")).length !== 51) {
  throw new Error("公开模板的 51 项预设商品库不完整");
}

if (migratedCatalog.transactions.length !== 0 || migratedCatalog.products.some(p => !["相机", "相纸"].includes(p.category))) throw Error("模板包含初始流水或多余商品类别");
if (document.querySelector("#savedListDialog, #selectionSummary, #ledgerListsToggle, [data-select-transaction]")) throw Error("模板残留个人清单界面");

function setValue(selector, value) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`找不到控件 ${selector}`);
  element.value = String(value);
  return element;
}

function submit(formSelector) {
  const form = document.querySelector(formSelector);
  const submitter = form.querySelector('button[value="default"]');
  const event = new window.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "submitter", { value: submitter });
  form.dispatchEvent(event);
}

function moneyForSmoke(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(value);
}

if ([...document.querySelectorAll("dialog .icon-button, dialog .dialog-actions .ghost")].some((button) => button.type !== "button" || (!button.hasAttribute("data-close-dialog") && button.id !== "cancelPhotoNoteButton"))) {
  throw new Error("仍有弹窗关闭按钮会触发表单必填校验");
}
document.querySelector("#addProductButton").click();
document.querySelector('#productDialog [data-close-dialog]').click();
if (document.querySelector("#productDialog").open) throw new Error("商品弹窗不能直接关闭");
document.querySelector("#addProductButton").click();
const newProductCategory = setValue('#productForm select[name="category"]', "相纸");
newProductCategory.dispatchEvent(new window.Event("change"));
if (document.querySelector("#productSeriesField").classList.contains("hidden") || !document.querySelector("#productSpecField").classList.contains("hidden")) {
  throw new Error("相纸商品录入没有按类别显示系列层级");
}
setValue('#productForm select[name="series"]', "Mini");
setValue('#productForm input[name="model"]', "测试新相纸");
setValue('#productForm input[name="capacity"]', 10);
setValue('#productForm input[name="officialPrice"]', 62);
submit("#productForm");

const numberFromText = (value) => Number(String(value).replace(/[^\d.-]/g, ""));

function addPurchase(quantity, price = 0, expiry = "2027-01") {
  document.querySelector("#addTransactionButton").click();
  const categorySelect = document.querySelector('#transactionForm select[name="productCategory"]');
  categorySelect.value = "相纸";
  categorySelect.dispatchEvent(new window.Event("change"));
  const seriesSelect = document.querySelector('#transactionForm select[name="productSeries"]');
  seriesSelect.value = "Mini";
  seriesSelect.dispatchEvent(new window.Event("change"));
  const productSelect = document.querySelector('#transactionForm select[name="productId"]');
  productSelect.value = [...productSelect.querySelectorAll("option")].find(option => option.textContent.includes("单白")).value;
  productSelect.dispatchEvent(new window.Event("change"));
  setValue('#transactionForm input[name="date"]', "2026-09-18");
  setValue('#transactionForm input[name="expiry"]', expiry);
  setValue('#transactionForm input[name="quantity"]', quantity);
  setValue('#transactionForm input[name="unitPrice"]', price);
  submit("#transactionForm");
}

function addDeduction(sourceId, type, quantity, price = 0, transfer = false) {
  document.querySelector(`[data-create-type="${type}"][data-source="${sourceId}"]`).click();
  if (!document.querySelector("#transactionProductField").classList.contains("hidden") || !document.querySelector("#transactionDateField").classList.contains("hidden") || !document.querySelector("#expiryField").classList.contains("hidden")) {
    throw new Error("售出/使用弹窗仍显示自动带入的商品、日期或有效期");
  }
  if (!document.querySelector("#transactionContext").textContent.includes("2027年01月")) throw new Error("售出/使用弹窗未自动带入批次有效期");
  if (type === "use" && (!["#unitPriceField", "#regionField", "#counterpartyField", "#transferField", "#notesField"].every((selector) => document.querySelector(selector).classList.contains("hidden")))) {
    throw new Error("使用弹窗除数量外仍有多余填写项");
  }
  if (type === "sale" && (["#unitPriceField", "#regionField", "#counterpartyField", "#transferField"].some((selector) => document.querySelector(selector).classList.contains("hidden")))) {
    throw new Error("售出弹窗缺少单价、平台、交易对象或原价转让项");
  }
  setValue('#transactionForm input[name="date"]', "2026-09-18");
  setValue('#transactionForm input[name="quantity"]', quantity);
  setValue('#transactionForm input[name="unitPrice"]', price);
  if (type === "sale") {
    if (document.querySelector('#counterpartyField span').textContent !== '交易对象' || document.querySelector('#regionField input').placeholder !== '填写新平台，保存后自动加入') throw Error('售出字段标签与提示错误');
    if (document.querySelector('#transactionForm select[name="platformChoice"] option[value="京东"]')) throw Error('售出混入购入预设');
    setValue('#transactionForm input[name="region"]', "闲鱼");
    setValue('#transactionForm input[name="counterparty"]', "测试买家");
  }
  document.querySelector('#transactionForm input[name="originalTransfer"]').checked = transfer;
  submit("#transactionForm");
}

addPurchase(5, 50);
const purchaseId = JSON.parse(localStorage.getItem("instant-inventory-state")).transactions.at(-1).id;
addDeduction(purchaseId, "sale", 2, 80);
addDeduction(purchaseId, "sale", 1, 50, true);
addDeduction(purchaseId, "use", 1, 0);

const createdTransactions = JSON.parse(localStorage.getItem("instant-inventory-state")).transactions;
const createdPurchase = createdTransactions.find((tx) => tx.id === purchaseId);
if (!createdPurchase) throw new Error("购入流水未创建");
const linkedDeductions = createdTransactions.filter((tx) => tx.productId === createdPurchase.productId && tx.id !== purchaseId);
if (linkedDeductions.filter((tx) => tx.type === "sale").length < 2 || linkedDeductions.filter((tx) => tx.type === "use").length < 1) {
  throw new Error("购入批次按钮未生成独立的售出/使用流水");
}
if (!document.querySelector(`[data-create-type="sale"][data-source="${purchaseId}"]`) || !document.querySelector(`[data-create-type="use"][data-source="${purchaseId}"]`)) {
  throw new Error("有库存的购入流水缺少售出/使用按钮");
}
if (!document.querySelector("#expiryList .product-visual img") || !document.querySelector("#ledgerList .product-visual img") || !document.querySelector("#inventoryBody .product-visual img")) {
  throw new Error(`到期提醒、库存或流水商品图未显示: ${["expiryList", "ledgerList", "inventoryBody"].map((id) => `${id}=${!!document.querySelector(`#${id} .product-visual img`)}`).join(", ")}`);
}

const profitBeforeEdit = numberFromText(document.querySelector("#trueProfit").textContent);
const miniBeforeEdit = numberFromText(document.querySelector("#miniSheets").textContent);
const beforeEdit = JSON.parse(localStorage.getItem("instant-inventory-state"));
const saleToEdit = beforeEdit.transactions.slice(-4).find((tx) => tx.type === "sale" && !tx.originalTransfer);
document.querySelector(`[data-edit="${saleToEdit.id}"]`).click();
if (document.querySelector("#transactionDialogTitle").textContent !== "修改流水") throw new Error("修改流水弹窗未打开");
setValue('#transactionForm input[name="unitPrice"]', 90);
submit("#transactionForm");

const afterEdit = JSON.parse(localStorage.getItem("instant-inventory-state"));
const editedSale = afterEdit.transactions.find((tx) => tx.id === saleToEdit.id);
if (afterEdit.transactions.length !== beforeEdit.transactions.length || editedSale.unitPrice !== 90) throw new Error("流水修改未正确保存");

const profit = document.querySelector("#trueProfit").textContent;
const mini = document.querySelector("#miniSheets").textContent.trim();
if (numberFromText(profit) !== Number((profitBeforeEdit + 20).toFixed(2))) throw new Error(`修改后真实利润交互校验失败：编辑前 ${profitBeforeEdit}，编辑后 ${profit}`);
if (numberFromText(mini) !== miniBeforeEdit) throw new Error(`修改流水后 Mini 张数异常：${mini}`);

addPurchase(2, 45, "");
const missingExpiryPurchaseId = JSON.parse(localStorage.getItem("instant-inventory-state")).transactions.at(-1).id;
const missingExpiryButton = document.querySelector(`[data-edit="${missingExpiryPurchaseId}"].expiry-missing`);
if (!missingExpiryButton) throw new Error("未填写有效期的购入流水没有待补提示");
document.querySelector(`[data-create-type="use"][data-source="${missingExpiryPurchaseId}"]`).click();
if (!document.querySelector("#transactionContext").textContent.includes("有效期待补")) throw new Error("缺失有效期的批次上下文提示不正确");
setValue('#transactionForm input[name="quantity"]', 1);
submit("#transactionForm");
const missingBatchUseId = JSON.parse(localStorage.getItem("instant-inventory-state")).transactions.at(-1).id;
document.querySelector(`[data-edit="${missingExpiryPurchaseId}"].expiry-missing`).click();
setValue('#transactionForm input[name="expiry"]', "2027-06");
submit("#transactionForm");
const expiryCompletedState = JSON.parse(localStorage.getItem("instant-inventory-state"));
if (expiryCompletedState.transactions.find((tx) => tx.id === missingExpiryPurchaseId).expiry !== "2027-06"
  || expiryCompletedState.transactions.find((tx) => tx.id === missingBatchUseId).expiry !== "2027-06") {
  throw new Error("后补有效期未同步到同批次的使用流水");
}

document.querySelector("#addProductButton").click();
const cameraProductCategory = setValue('#productForm select[name="category"]', "相机");
cameraProductCategory.dispatchEvent(new window.Event("change"));
if (!document.querySelector("#productSeriesField").classList.contains("hidden") || document.querySelector("#productSpecField").classList.contains("hidden")) {
  throw new Error("相机商品录入没有直接显示型号和颜色");
}
setValue('#productForm input[name="model"]', "SQ6");
setValue('#productForm input[name="spec"]', "Taylor Swift");
submit("#productForm");
document.querySelector("#addTransactionButton").click();
const cameraCategory = document.querySelector('#transactionForm select[name="productCategory"]');
cameraCategory.value = "相机";
cameraCategory.dispatchEvent(new window.Event("change"));
const cameraSelect = document.querySelector('#transactionForm select[name="productId"]');
cameraSelect.value = [...cameraSelect.querySelectorAll("option")].at(-1).value;
cameraSelect.dispatchEvent(new window.Event("change"));
if (!document.querySelector("#expiryField").classList.contains("hidden")) throw new Error("普通相机仍显示有效期字段");
setValue('#transactionForm input[name="date"]', "2026-09-18");
setValue('#transactionForm input[name="quantity"]', 1);
setValue('#transactionForm input[name="unitPrice"]', 1200);
submit("#transactionForm");
const savedCameraPurchase = JSON.parse(localStorage.getItem("instant-inventory-state")).transactions.at(-1);
if (savedCameraPurchase.expiry !== "") throw new Error("普通相机错误保存了有效期");

document.querySelector("#expirySetting").click();
setValue('#expiryForm input[name="days"]', 1);
submit("#expiryForm");
const shortRangeCount = document.querySelectorAll("#expiryList .expiry-item").length;
document.querySelector("#expirySetting").click();
setValue('#expiryForm input[name="days"]', 730);
submit("#expiryForm");
const longRangeCount = document.querySelectorAll("#expiryList .expiry-item").length;
if (longRangeCount <= shortRangeCount) throw new Error("修改到期提醒天数后列表没有重新计算");

document.querySelector("#addTransactionButton").click();
const quantityCategorySelect = document.querySelector('#transactionForm select[name="productCategory"]');
quantityCategorySelect.value = "相纸";
quantityCategorySelect.dispatchEvent(new window.Event("change"));
const quantitySeriesSelect = document.querySelector('#transactionForm select[name="productSeries"]');
quantitySeriesSelect.value = "Mini";
quantitySeriesSelect.dispatchEvent(new window.Event("change"));
const quantityProductSelect = document.querySelector('#transactionForm select[name="productId"]');
quantityProductSelect.value = createdPurchase.productId;
quantityProductSelect.dispatchEvent(new window.Event("change"));
if (document.querySelector('#transactionForm input[name="quantity"]').step !== "0.5") throw new Error("相纸数量没有限制为半盒递增");
setValue('#transactionForm input[name="date"]', "2026-09-18");
setValue('#transactionForm input[name="expiry"]', "2027-01");
setValue('#transactionForm input[name="quantity"]', 0.5);
setValue('#transactionForm input[name="unitPrice"]', 50);
submit("#transactionForm");
if (!document.querySelector("#ledgerList").textContent.includes("0.5 盒") || document.querySelector("#ledgerList").textContent.includes("0.50 盒")) {
  throw new Error("半盒数量没有按 0.5 显示");
}

document.querySelector("#transactionDialog").close();
document.querySelector("#addTransactionButton").click();
const hierarchyCategory = document.querySelector('#transactionForm select[name="productCategory"]');
hierarchyCategory.value = "相纸";
hierarchyCategory.dispatchEvent(new window.Event("change"));
if (document.querySelector("#transactionSeriesField").classList.contains("hidden")) throw new Error("选择相纸后未显示系列选择");
const hierarchySeries = document.querySelector('#transactionForm select[name="productSeries"]');
hierarchySeries.value = "SQ";
hierarchySeries.dispatchEvent(new window.Event("change"));
const hierarchyProducts = [...document.querySelectorAll('#transactionForm select[name="productId"] option')].slice(1);
if (!hierarchyProducts.length || hierarchyProducts.some((option) => !option.textContent.includes("库存") || option.textContent.includes("Mini"))) {
  throw new Error("相纸层级选择没有按系列筛选具体商品");
}
hierarchyCategory.value = "相机";
hierarchyCategory.dispatchEvent(new window.Event("change"));
if (!document.querySelector("#transactionSeriesField").classList.contains("hidden") || !document.querySelector('#transactionForm select[name="productId"]').textContent.includes("Mini9")) {
  throw new Error("相机层级选择没有直接显示具体型号");
}
document.querySelector("#transactionDialog").close();

setValue("#inventorySearch", "单白").dispatchEvent(new window.Event("input"));
if (document.querySelectorAll("#inventoryBody tr").length !== 1) throw new Error("库存没有按具体型号合并不同批次");
if (document.querySelector("#inventoryBody .product-cell strong")?.textContent !== "Mini · 单白"
  || document.querySelector("#inventoryBody .product-cell small")?.textContent !== "相纸") {
  throw new Error("白边相纸没有直接显示装数规格");
}
const historyState = JSON.parse(localStorage.getItem("instant-inventory-state"));
const historyProductId = historyState.products.find(p => p.category === "相纸" && p.series === "Mini" && p.spec === "单白").id;
const historyPurchases = historyState.transactions.filter(t => t.productId === historyProductId && t.type === "purchase");
const expectedHistoryPrice = historyPurchases.reduce((sum, t) => sum + t.quantity * t.unitPrice, 0) / historyPurchases.reduce((sum, t) => sum + t.quantity, 0);
if (Math.abs(numberFromText(document.querySelector("#inventoryBody .inventory-history-price").textContent) - expectedHistoryPrice) > 0.005) throw new Error("历史购入均价未按全部购入数量加权计算");
if (!document.querySelector(".inventory-table thead").textContent.includes("当前库存均价") || !document.querySelector(".inventory-table thead").textContent.includes("历史购入均价")) throw new Error("库存均价表头不清晰");
if (document.querySelector("#inventoryBody").textContent.includes("张")) throw new Error("库存概览仍显示剩余张数");
if (document.body.textContent.includes("市场价值") || document.querySelector('#productForm [name="marketPrice"]')) throw new Error("网站仍显示或录入市场价值");
if (!document.querySelector("#officialInventoryValue")?.textContent.includes("¥")) throw new Error("首页没有显示当前库存官方价总额");
if (numberFromText(document.querySelector("#totalFilmValue")?.textContent) <= 0 || document.querySelector("#totalFilmUnit")?.textContent !== "张") throw new Error("剩余相纸没有显示全部系列合计");
const miniSheetsBeforeToggle = document.querySelector("#miniSheets").textContent;
const totalSheetsBeforeToggle = document.querySelector("#totalFilmValue").textContent;
document.querySelector("#filmUnitToggle").click();
if (document.querySelector("#miniSheets").textContent === miniSheetsBeforeToggle || document.querySelector(".sheet-count small").textContent !== "盒") throw new Error("剩余相纸没有切换为盒数");
if (document.querySelector("#totalFilmValue").textContent === totalSheetsBeforeToggle || document.querySelector("#totalFilmUnit").textContent !== "盒") throw new Error("全部系列合计没有随按钮切换为盒数");
document.querySelector("#filmUnitToggle").click();
if (document.querySelector(".sheet-count small").textContent !== "张" || document.querySelector("#totalFilmUnit").textContent !== "张") throw new Error("剩余相纸没有切回张数");
const pricedTransaction = afterEdit.transactions.find((tx) => tx.type !== "use" && tx.unitPrice > 0);
document.querySelector('#transactionType button[data-value="全部"]').click();
const pricedRow = document.querySelector(`#ledgerList .ledger-row[data-transaction-id="${pricedTransaction.id}"]`);
if (!pricedRow || !pricedRow.querySelector(".ledger-unit-price").textContent.includes(moneyForSmoke(pricedTransaction.unitPrice))) throw new Error("流水未显示单价");
const regionTransaction = afterEdit.transactions.find((tx) => tx.region && tx.counterparty && tx.region !== tx.counterparty);
const regionRow = regionTransaction && document.querySelector(`#ledgerList .ledger-row[data-transaction-id="${regionTransaction.id}"]`);
if (!regionRow?.querySelector(".ledger-meta")?.textContent.includes(regionTransaction.region)
  || regionRow.querySelector(".ledger-meta").textContent.includes(regionTransaction.counterparty)) {
  throw new Error("流水商品下方没有用平台/地区替换交易对象");
}
document.querySelector('#transactionType button[data-value="sale"]').click();
const saleFilterRows = document.querySelectorAll("#ledgerList .ledger-row:not(.header)").length;
const expectedSaleRows = afterEdit.transactions.filter((tx) => tx.type === "sale").length;
if (saleFilterRows !== expectedSaleRows) throw new Error("流水类型筛选交互校验失败");
document.querySelector('#transactionType button[data-value="全部"]').click();
setValue("#ledgerCategory", "相机").dispatchEvent(new window.Event("change"));
const currentState = JSON.parse(localStorage.getItem("instant-inventory-state"));
const cameraProductIds = new Set(currentState.products.filter((product) => product.category === "相机").map((product) => product.id));
const expectedCameraRows = currentState.transactions.filter((tx) => cameraProductIds.has(tx.productId)).length;
const cameraRows = [...document.querySelectorAll("#ledgerList .ledger-row:not(.header)")];
if (cameraRows.length !== expectedCameraRows) throw new Error("流水商品类别筛选失败");
if (cameraRows.some((row) => row.querySelector(".ledger-product strong")?.textContent.includes("SQ · SQ1"))) throw new Error("相机名称仍重复显示系列");
if (!cameraRows.some((row) => row.querySelector(".ledger-product strong")?.textContent === "SQ6 · Taylor Swift")) throw new Error("相机型号与颜色之间没有使用分隔点");
if (cameraRows.some((row) => !row.querySelector(".ledger-product .ledger-meta"))) throw new Error("流水商品次要信息缺少移动端隐藏标记");

setValue("#ledgerCategory", "").dispatchEvent(new window.Event("change"));
const mobileCss = await readFile(new URL("../dist/client/styles.css", import.meta.url), "utf8");
if (!mobileCss.includes(".inventory-table table { display: block; width: 100%; min-width: 0; }")
  || !mobileCss.includes(".ledger-date { grid-column: 1; grid-row: 2; min-width: 0; white-space: nowrap;")
  || !mobileCss.includes(".ledger-product { grid-column: 1; grid-row: 1;")
  || !mobileCss.includes(".row-actions { justify-content: flex-end; flex-wrap: nowrap;")
  || !mobileCss.includes(".account-button { grid-column: 1 / -1;")
  || mobileCss.includes(".top-actions .ghost { display: none;")) {
  throw new Error("移动端库存或流水紧凑布局未生效");
}

console.log(JSON.stringify({ productCreate: true, productHierarchy: true, directDialogClose: true, mobileProductButton: true, purchaseBatchActions: true, generatedSaleAndUseRecords: true, simplifiedSaleAndUseForms: true, monthOnlyExpiry: true, missingExpiryReminder: true, cameraExpiryDisabled: true, dynamicExpiryRange: true, halfBoxQuantityStep: true, hierarchicalProductPicker: true, productImages: true, transactionEdit: true, inventoryGroupedByModel: true, ledgerUnitPrice: true, noMarketValue: true, officialInventoryValue: true, filmUnitToggle: true, totalFilmBalance: true, ledgerRegionDisplay: true, ledgerCategoryFilter: true, cameraNameSimplified: true, whiteBorderFilmSimplified: true, mobileInventoryCompact: true, mobileLedgerActionsInline: true, profit, miniSheets: mini, inventoryFilterRows: 1, saleFilterRows }));

await new Promise(resolve => setTimeout(resolve, 20));
if (!document.querySelector('.nav-link[data-section="products"]')) throw Error('商品库导航缺失');
if (!document.querySelector('#productLibraryGroups').textContent.includes('尚未购入')) throw Error('商品库未展示未购入商品');
const productCountBeforeDuplicate = JSON.parse(localStorage.getItem('instant-inventory-state')).products.length;
document.querySelector('#libraryAddProduct').click();
setValue('#productForm select[name="category"]', '相纸').dispatchEvent(new window.Event('change'));
setValue('#productForm select[name="series"]', 'Mini');
setValue('#productForm input[name="model"]', ' 测试新相纸 ');
setValue('#productForm input[name="capacity"]', 10);
submit('#productForm');
if (JSON.parse(localStorage.getItem('instant-inventory-state')).products.length !== productCountBeforeDuplicate || !document.querySelector('#productDialog').open) throw Error('重复商品未被拦截');
if (!document.querySelector('#productDialog .dialog-notice[role="alert"]')?.textContent.includes('商品库已有这个商品')) throw Error('重复商品提醒未显示在弹窗内');
document.querySelector('#productDialog [data-close-dialog]').click();
if (document.querySelector('#productDialog .dialog-notice')) throw Error('关闭弹窗后仍残留旧提醒');
document.querySelector('#libraryCategory button[data-value="相纸"]').click();
document.querySelector('#librarySeries button[data-value="SQ"]').click();
if ([...document.querySelectorAll('#productLibraryGroups .library-product-info strong')].some(item => !item.textContent.startsWith('SQ'))) throw Error('商品库系列筛选错误');
setValue('#librarySearch', '不存在的商品xyz').dispatchEvent(new window.Event('input'));
if (document.querySelectorAll('#productLibraryGroups .library-product-card').length) throw Error('商品库搜索错误');
setValue('#librarySearch', '').dispatchEvent(new window.Event('input'));
console.log(JSON.stringify({productLibraryShowsUnused:true,productLibraryHierarchy:true,duplicateProductBlocked:true}));
document.querySelector('#libraryCategory button[data-value="全部"]').click();
const beforeDelete = JSON.parse(localStorage.getItem('instant-inventory-state'));
const usedId = beforeDelete.transactions[0].productId;
const unusedId = beforeDelete.products.find(product => !beforeDelete.transactions.some(tx => tx.productId === product.id)).id;
document.querySelector(`[data-delete-product="${usedId}"]`).click();
if (!JSON.parse(localStorage.getItem('instant-inventory-state')).products.some(product => product.id === usedId)) throw Error('有关联流水的商品被删除');
window.confirm = () => false;
document.querySelector(`[data-delete-product="${unusedId}"]`).click();
if (!JSON.parse(localStorage.getItem('instant-inventory-state')).products.some(product => product.id === unusedId)) throw Error('取消删除仍删除了商品');
window.confirm = () => true;
document.querySelector(`[data-delete-product="${unusedId}"]`).click();
await new Promise(resolve => setTimeout(resolve, 20));
const afterDelete = JSON.parse(localStorage.getItem('instant-inventory-state'));
if (afterDelete.products.some(product => product.id === unusedId) || JSON.stringify(afterDelete.transactions) !== JSON.stringify(beforeDelete.transactions)) throw Error('商品删除或历史流水保护错误');
document.querySelector('#addTransactionButton').click();
if (document.querySelector('#regionField input').placeholder !== '填写新平台，保存后自动加入') throw Error('购入平台提示错误');
if (document.querySelector('#regionField span').textContent !== '平台' || document.querySelector('#counterpartyField span').textContent !== '店铺名称') throw Error('流水字段文案未更新');
document.querySelector('#transactionDialog [data-close-dialog]').click();
console.log(JSON.stringify({unusedProductDeletion:true, linkedProductProtected:true, deletionCancel:true, transactionLabels:true}));
failWrites = true;
document.querySelector("#addProductButton").click();
setValue('#productForm input[name="model"]', "离线同步测试");
submit("#productForm");
await new Promise(resolve => setTimeout(resolve, 20));
const pendingBefore = localStorage.getItem("instant-inventory-pending");
if (!pendingBefore || !pendingBefore.includes("离线同步测试")) throw new Error("断网修改没有保存到待同步备份");
failWrites = false;
remoteRevision = 99;
window.dispatchEvent(new window.Event("focus"));
await new Promise(resolve => setTimeout(resolve, 20));
if (document.querySelector("#resolveConflict").classList.contains("hidden") || localStorage.getItem("instant-inventory-pending") !== pendingBefore) throw new Error("跨设备冲突没有保留本机更改");
console.log(JSON.stringify({offlineEditsRetained:true, crossDeviceConflictPreservesLocal:true, albumRemoved:!document.querySelector("#album"), ownerUnlockPresent:!!document.querySelector("#unlockForm")}));

const bottomLinks = document.querySelectorAll('.mobile-bottom-nav .nav-link');
if (bottomLinks.length !== 4) throw Error('手机底部菜单入口不完整');
for (const link of bottomLinks) {
  link.click();
  const activeLinks = [...document.querySelectorAll('.nav-link.active')];
  if (activeLinks.length !== 2 || activeLinks.some(item => item.dataset.section !== link.dataset.section || item.getAttribute('aria-current') !== 'page')) throw Error('底部与侧边导航选中状态不同步');
}
console.log(JSON.stringify({mobileBottomNavigation:true, navigationHighlightSynced:true}));

setValue("#ledgerExpiry", "__pending").dispatchEvent(new window.Event("change"));
if (document.querySelector("#ledgerExpiry").value !== "__pending") throw Error("待补有效期筛选被重置");
if (!document.querySelector('#ledgerExpiry option[value="__unknown"]')) throw Error("缺少有效期未知筛选");
setValue("#ledgerExpiry", "__unknown").dispatchEvent(new window.Event("change"));
if (document.querySelector("#ledgerExpiry").value !== "__unknown") throw Error("未知有效期筛选被重置");
setValue("#ledgerExpiry", "").dispatchEvent(new window.Event("change"));
console.log(JSON.stringify({pendingExpiryFilter:true,unknownExpiryFilter:true,expirySelectionPersists:true}));

if (!JSON.parse(localStorage.getItem('instant-inventory-state')).settings.salePlatforms.includes('闲鱼')) throw Error('新增平台未随流水持久化');

