/* 作品库:历史姿态与生图结果的浏览
 *
 * 责任:把 store 里的记录渲染成可回访的列表,并发出"选中某条"的语义事件。
 * 事件:gallery:open { kind:"pose"|"result", id }
 *
 * 现状:骨架。列表枚举依赖 store 的 listPoses / listResults,尚未实现。
 */
(function (app) {
  "use strict";

  var container = null;

  function init(element) {
    container = element || container;
    if (!container) return false;
    /* TODO:渲染空态占位,等 store 提供枚举后再接列表 */
    container.textContent = app.i18n.text("作品库待实现", "Gallery is not implemented yet");
    return true;
  }

  function render() {
    throw new Error("作品库渲染尚未实现:需要 store 先提供列表能力");
  }

  app.components.gallery = { init: init, render: render };
})(window.posegi);
