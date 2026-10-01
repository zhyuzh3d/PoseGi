/* 界面基元:提示条、底部弹层、确认框、选择框、按钮动作包装
 *
 * 责任:只处理 DOM 与语义事件,不含业务判断。
 * 约束:必须用 Android WebView 能跑的定位方式(fixed + 四边),不用 flex gap。
 *      界面上不出现任何系统控件:确认与选择都是自绘的一层(2026-09-30 用户要求)。
 * 用法:app.components.ui.toast(text, "error") / openSheet({...}) / confirm({...}) /
 *      choose({...}) / action(fn)
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
    nodes.pickerLayer = node("picker-layer");
    nodes.pickerTitle = node("picker-title");
    nodes.pickerList = node("picker-list");
    Array.prototype.forEach.call(document.querySelectorAll("[data-close-modal]"), function (button) {
      button.onclick = closeSheet;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-close-picker]"), function (button) {
      button.onclick = function () { settleChoice(null); };
    });
    if (nodes.confirmCancel) nodes.confirmCancel.onclick = function () { settle(false); };
    if (nodes.modalLayer) nodes.modalLayer.hidden = true;
    if (nodes.confirmLayer) nodes.confirmLayer.hidden = true;
    if (nodes.pickerLayer) nodes.pickerLayer.hidden = true;
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

  /* sheet 的布局变体:某一张 sheet 想把「哪一块滚动」换个分法时,调 openSheet 时带一个
     variant 名,由 CSS 按这个标记重新分配。**每次 openSheet 都要重设一遍** ——
     弹层是单例,标记漏清就会漏给下一张 sheet(生成弹窗要钉住底部,模型列表却跟着不滚了,
     而它一个字都没改)。 */
  var SHEET_VARIANTS = ["sheet-scroll-results"];
  function setSheetVariant(variant) {
    var section = nodes.modalLayer ? nodes.modalLayer.querySelector(".modal-sheet") : null;
    if (!section || !section.classList) return;
    SHEET_VARIANTS.forEach(function (name) { section.classList.remove(name); });
    if (variant) section.classList.add(String(variant));
  }

  function openSheet(options) {
    var sheet = options || {};
    if (!nodes.modalLayer) return null;
    nodes.modalTitle.textContent = String(sheet.title || "");
    nodes.modalEyebrow.textContent = String(sheet.eyebrow || "");
    nodes.modalContent.innerHTML = String(sheet.bodyHtml || "");
    nodes.modalActions.innerHTML = String(sheet.footerHtml || "");
    nodes.modalActions.hidden = !sheet.footerHtml;
    setSheetVariant(sheet.variant);
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
    /* 这一层是 index.html 里的固定结构,拿不到就是页面自己坏了 ——
       不再退到 window.confirm:那个系统弹窗的配色与字体与这里完全是两套,
       而"看起来像别人的界面"正是用户 2026-09-30 要求清掉的东西。 */
    if (!nodes.confirmLayer) return Promise.resolve(false);
    if (pendingConfirm) settle(false);
    nodes.confirmTitle.textContent = String(value.title || "");
    nodes.confirmMessage.textContent = String(value.message || "");
    nodes.confirmOk.textContent = String(value.okText || app.i18n.text("确定", "OK"));
    nodes.confirmCancel.textContent = String(value.cancelText || app.i18n.text("取消", "Cancel"));
    nodes.confirmOk.onclick = function () { settle(true); };
    nodes.confirmLayer.hidden = false;
    return new Promise(function (resolve) { pendingConfirm = resolve; });
  }

  /* 选择框:一列选项,点一条就定了,点背景或关闭按钮算没选(回 null)。
   *
   * 为什么单开一层而不是复用底部弹层:选择框总是在**某张表单里面**被点开
   * (模型卡、翻译卡),而底部弹层是单例 —— 复用就等于把表单连同已经填好的
   * 地址与密码一起顶掉。所以它像确认框那样自己占一层,表单原样留在下面,
   * 选完关掉这一层,用户回到的是他刚才那张表单。
   *
   * items 形如 [[value, label], …];不分页、不做搜索:选项最多八条
   * (插件公布的画幅档数),一屏能看完的事不需要再套一层查找。 */
  var pendingChoice = null;

  function settleChoice(value) {
    if (!pendingChoice) return;
    var resolve = pendingChoice;
    pendingChoice = null;
    if (nodes.pickerLayer) nodes.pickerLayer.hidden = true;
    resolve(value);
  }

  function choose(options) {
    var value = options || {}, items = value.items || [];
    if (!nodes.pickerLayer) return Promise.resolve(null);
    if (pendingChoice) settleChoice(null);
    nodes.pickerTitle.textContent = String(value.title || app.i18n.text("请选择", "Choose"));
    nodes.pickerList.innerHTML = items.map(function (item) {
      var picked = String(item[0]) === String(value.current);
      return '<button type="button" class="picker-option' + (picked ? " is-selected" : "") +
        '" data-picker-option="' + app.utils.escapeHtml(item[0]) + '"' + (picked ? ' aria-current="true"' : "") + '>' +
        "<span>" + app.utils.escapeHtml(item[1]) + "</span>" +
        '<i class="fa-solid fa-check" aria-hidden="true"></i></button>';
    }).join("");
    /* 逐项绑而不是事件委托:列表每次重画,数量是个位数,而委托要往上找祖先,
       旧内核上 Element.closest 不一定在。 */
    Array.prototype.forEach.call(nodes.pickerList.querySelectorAll("[data-picker-option]"), function (button) {
      button.onclick = function () { settleChoice(button.dataset.pickerOption); };
    });
    nodes.pickerLayer.hidden = false;
    return new Promise(function (resolve) { pendingChoice = resolve; });
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
    choose: choose,
    action: action
  };
})(window.posegi);
