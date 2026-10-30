import { batchKey } from "./core.mjs";

export function shortLedgerDate(value, monthOnly = false) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(value || ""));
  if (!match) return "";
  return match[1].slice(-2) + "/" + Number(match[2]) + (!monthOnly && match[3] ? "/" + Number(match[3]) : "");
}

export function ledgerUseUnitCost(state, tx) {
  const rows = state.transactions.filter(row => row.type === "purchase" && row.quantity > 0
    && batchKey(row.productId, row.lotId, row.expiry) === batchKey(tx.productId, tx.lotId, tx.expiry));
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  return quantity ? rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0) / quantity : null;
}

// Horizontal gestures reveal actions; vertical gestures remain native page scrolling.
export function initLedgerSwipe(list, win = window) {
  if (!win.matchMedia || !win.MutationObserver) return;
  const media = win.matchMedia("(max-width: 760px)");
  let opened = null, drag = null, suppressClick = false;
  const buttons = row => [...row.querySelectorAll(".ledger-actions button")];
  const width = row => row.querySelector(".ledger-actions").getBoundingClientRect().width;
  function syncRow(row, open = false) {
    const actions = row.querySelector(".ledger-actions");
    if (!actions) return;
    row.classList.toggle("swipe-open", open);
    row.querySelector(".ledger-face")?.style.removeProperty("transform");
    actions.setAttribute("aria-hidden", String(media.matches && !open));
    buttons(row).forEach(button => { button.tabIndex = media.matches && !open ? -1 : 0; });
    row.querySelector(".ledger-face")?.setAttribute("aria-expanded", String(open));
  }
  function close() {
    if (opened) syncRow(opened);
    opened = null;
  }
  function open(row) {
    if (opened !== row) close();
    opened = row;
    row.style.setProperty("--swipe-width", width(row) + "px");
    syncRow(row, true);
  }
  function refresh() {
    close();
    list.querySelectorAll(".ledger-row:not(.header)").forEach(row => syncRow(row));
  }
  list.addEventListener("pointerdown", event => {
    if (!media.matches || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    const row = event.target.closest(".ledger-row:not(.header)");
    if (!row || event.target.closest(".ledger-actions, input, button") || !width(row)) return;
    if (opened && opened !== row) close();
    drag = { row, face: row.querySelector(".ledger-face"), id: event.pointerId, x: event.clientX, y: event.clientY, start: opened === row ? -width(row) : 0, axis: "", offset: 0 };
  });
  list.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
      if (Math.abs(dy) >= Math.abs(dx)) { drag = null; close(); return; }
      drag.axis = "x";
      drag.face.setPointerCapture?.(event.pointerId);
      drag.row.classList.add("swipe-dragging");
    }
    if (drag.axis !== "x") return;
    event.preventDefault();
    drag.offset = Math.max(-width(drag.row), Math.min(0, drag.start + dx));
    drag.face.style.transform = "translateX(" + drag.offset + "px)";
  }, { passive: false });
  function finish(event, cancel = false) {
    if (!drag || drag.id !== event.pointerId) return;
    const current = drag;
    drag = null;
    current.row.classList.remove("swipe-dragging");
    current.face.style.removeProperty("transform");
    if (current.axis !== "x") return;
    suppressClick = true;
    win.setTimeout(() => { suppressClick = false; }, 0);
    if (!cancel && -current.offset > Math.min(48, width(current.row) * 0.3)) open(current.row);
    else close();
  }
  list.addEventListener("pointerup", event => finish(event));
  list.addEventListener("pointercancel", event => finish(event, true));
  list.addEventListener("click", event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (opened && event.target.closest(".ledger-face")) {
      close(); event.preventDefault(); event.stopImmediatePropagation();
    } else if (event.target.closest(".ledger-actions")) close();
  }, true);
  list.addEventListener("keydown", event => {
    if (!media.matches) return;
    if (event.key === "Escape" || event.key === "ArrowRight") { close(); return; }
    if (event.key === "ArrowLeft") {
      const row = event.target.closest(".ledger-row:not(.header)");
      if (row) { event.preventDefault(); open(row); buttons(row)[0]?.focus(); }
    }
  });
  win.document.addEventListener("pointerdown", event => {
    if (opened && !opened.contains(event.target)) close();
  });
  win.addEventListener("scroll", close, { passive: true });
  media.addEventListener?.("change", refresh);
  new win.MutationObserver(records => {
    if (records.some(record => record.type === "childList" && record.target === list)) refresh();
  }).observe(list, { childList: true });
  refresh();
}
