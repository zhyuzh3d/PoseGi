/* 界面基元:提示条、底部弹层、确认框、按钮动作包装
 *
 * 责任:只处理 DOM 与语义事件,不含业务判断。
 * 约束:必须用 Android WebView 能跑的定位方式(fixed + 四边),不用 flex gap。
 * 用法:app.components.ui.toast(text, "error") / openSheet({...}) / confirm({...}) / action(fn)
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
    var text = String(message || "");
    var existing = Array.prototype.slice.call(nodes.toastStack.children).filter(function (item) {
      return item.dataset && item.dataset.message === text;
    })[0];
    if (existing) return;
    while (nodes.toastStack.children.length >= 2) nodes.toastStack.removeChild(nodes.toastStack.firstChild);
    var item = document.createElement("div");
    item.className = "toast" + (kind ? " toast-" + kind : "");
    item.dataset.message = text;
    item.textContent = text;
    nodes.toastStack.appendChild(item);
    setTimeout(function () { item.classList.add("toast-in"); }, 16);
    setTimeout(function () {
      item.classList.remove("toast-in");
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 260);
    }, kind === "error" ? 6000 : 3200);
  }

  /* 底部弹层:内容与底部动作由调用方给出,关闭统一走 closeSheet */
  var closeHandler = null;

  function openSheet(options) {
    var sheet = options || {};
    if (!nodes.modalLayer) return null;
    nodes.modalTitle.textContent = String(sheet.title || "");
    nodes.modalEyebrow.textContent = String(sheet.eyebrow || "");
    nodes.modalContent.innerHTML = String(sheet.bodyHtml || "");
    nodes.modalActions.innerHTML = String(sheet.footerHtml || "");
    nodes.modalActions.hidden = !sheet.footerHtml;
    nodes.modalLayer.hidden = false;
    app.i18n.apply(nodes.modalContent);
    /* 关闭之后该回到哪一层。弹层是单例,后开的会顶掉先开的,所以这个回调必须
       跟着"最后一次 openSheet"走:生成弹窗 → 模型列表 → 编辑卡片 这条链上,
       关掉卡片该回列表,关掉列表该回生成弹窗(2026-09-26 用户要的)。 */
    closeHandler = typeof sheet.onClose === "function" ? sheet.onClose : null;
    if (typeof sheet.onMount === "function") sheet.onMount(nodes.modalContent, nodes.modalActions);
    return nodes.modalContent;
  }

  function closeSheet() {
    if (!nodes.modalLayer) return;
    nodes.modalLayer.hidden = true;
    /* 先把回调摘下来再调:回调里通常要 openSheet 把上一层摆回来,
       而 openSheet 会重设 closeHandler —— 顺序反了就会把新那层一起清掉。 */
    var handler = closeHandler;
    closeHandler = null;
    if (handler) handler();
  }

  function sheetOpen() {
    return Boolean(nodes.modalLayer && !nodes.modalLayer.hidden);
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
    if (pendingConfirm) settle(false);
    nodes.confirmTitle.textContent = String(value.title || "");
    nodes.confirmMessage.textContent = String(value.message || "");
    nodes.confirmOk.textContent = String(value.okText || app.i18n.text("确定", "OK"));
    nodes.confirmCancel.textContent = String(value.cancelText || app.i18n.text("取消", "Cancel"));
    nodes.confirmOk.onclick = function () { settle(true); };
    nodes.confirmLayer.hidden = false;
    return new Promise(function (resolve) { pendingConfirm = resolve; });
  }

  /* 按钮动作包装:执行期间禁用按钮,异常统一变成提示。
     生图这类会长跑的动作全靠它挡重复点击 —— 没有它,连点两下就是两个任务。 */
  function action(handler) {
    return function (event) {
      var button = event && event.currentTarget;
      var wasDisabled = button && button.disabled;
      if (button) button.disabled = true;
      var done = function () {
        if (button && button.isConnected) button.disabled = Boolean(wasDisabled);
      };
      var failed = function (error) {
        toast(app.utils.cleanError(error), "error");
        done();
      };
      try {
        var result = handler(event);
        if (result && typeof result.then === "function") return result.then(function (value) { done(); return value; }, failed);
        done();
        return result;
      } catch (error) {
        failed(error);
      }
    };
  }

  app.components.ui = {
    init: init,
    toast: toast,
    openSheet: openSheet,
    closeSheet: closeSheet,
    sheetOpen: sheetOpen,
    confirm: confirm,
    action: action
  };
})(window.posegi);
