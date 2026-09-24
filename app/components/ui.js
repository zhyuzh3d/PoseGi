/* 界面基元:提示条、底部弹层、确认框
 *
 * 责任:只处理 DOM 与语义事件,不含业务判断。
 * 约束:必须用 Android WebView 能跑的定位方式(fixed + 四边),不用 flex gap。
 * 用法:app.components.ui.toast(text, "error") / openSheet({...}) / confirm({...})
 */
(function (app) {
  "use strict";

  var nodes = {};

  function node(id) { return document.getElementById(id); }

  function init() {
    nodes.toastStack = node("toast-stack");
    nodes.modalLayer = node("modal-layer");
    nodes.modalTitle = node("modal-title");
    nodes.modalEyebrow = node("modal-eyebrow");
    nodes.modalContent = node("modal-content");
    nodes.modalActions = node("modal-actions");
    nodes.confirmLayer = node("confirm-layer");
    nodes.confirmTitle = node("confirm-title");
    nodes.confirmMessage = node("confirm-message");
    nodes.confirmOk = node("confirm-ok");
    nodes.confirmCancel = node("confirm-cancel");
    Array.prototype.forEach.call(document.querySelectorAll("[data-close-modal]"), function (button) {
      button.onclick = closeSheet;
    });
    if (nodes.confirmCancel) nodes.confirmCancel.onclick = function () { settle(false); };
    if (nodes.modalLayer) nodes.modalLayer.hidden = true;
    if (nodes.confirmLayer) nodes.confirmLayer.hidden = true;
    return nodes;
  }

  function toast(message, kind) {
    if (!nodes.toastStack) return;
    var item = document.createElement("div");
    item.className = "toast" + (kind ? " toast-" + kind : "");
    item.textContent = String(message || "");
    nodes.toastStack.appendChild(item);
    setTimeout(function () { item.classList.add("toast-in"); }, 16);
    setTimeout(function () {
      item.classList.remove("toast-in");
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 260);
    }, kind === "error" ? 6000 : 3200);
  }

  /* 底部弹层:内容与底部动作由调用方给出,关闭统一走 closeSheet */
  function openSheet(options) {
    var sheet = options || {};
    if (!nodes.modalLayer) return null;
    nodes.modalTitle.textContent = String(sheet.title || "");
    nodes.modalEyebrow.textContent = String(sheet.eyebrow || "");
    nodes.modalContent.innerHTML = String(sheet.bodyHtml || "");
    nodes.modalActions.innerHTML = String(sheet.footerHtml || "");
    nodes.modalActions.hidden = !sheet.footerHtml;
    nodes.modalLayer.hidden = false;
    if (typeof sheet.onMount === "function") sheet.onMount(nodes.modalContent, nodes.modalActions);
    return nodes.modalContent;
  }

  function closeSheet() {
    if (!nodes.modalLayer) return;
    nodes.modalLayer.hidden = true;
  }

  var pendingConfirm = null;

  function settle(value) {
    if (!pendingConfirm) return;
    var resolve = pendingConfirm;
    pendingConfirm = null;
    if (nodes.confirmLayer) nodes.confirmLayer.hidden = true;
    resolve(value);
  }

  function confirm(options) {
    var value = options || {};
    if (!nodes.confirmLayer) return Promise.resolve(window.confirm(String(value.message || "")));
    nodes.confirmTitle.textContent = String(value.title || "");
    nodes.confirmMessage.textContent = String(value.message || "");
    nodes.confirmOk.textContent = String(value.okText || app.i18n.text("确定", "OK"));
    nodes.confirmCancel.textContent = String(value.cancelText || app.i18n.text("取消", "Cancel"));
    nodes.confirmOk.onclick = function () { settle(true); };
    nodes.confirmLayer.hidden = false;
    return new Promise(function (resolve) { pendingConfirm = resolve; });
  }

  app.components.ui = {
    init: init,
    toast: toast,
    openSheet: openSheet,
    closeSheet: closeSheet,
    confirm: confirm
  };
})(window.posegi);
