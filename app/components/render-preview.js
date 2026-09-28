/* 成图全屏查看:双指放缩、拖动平移、双击复位、删除
 *
 * 责任:把一张成图铺满整屏给人看,并让"看的时候就能删掉它"。
 * 约束:整层挂在 body 上(不放进任何 flex 父级),用 fixed 铺满视口 ——
 *       弹层用的是 flex 布局,如果这层住在里面会被父级的尺寸约束住(hamdraw 踩过,专门写了 !important 修正)。
 *
 * 交互照搬 hamdraw 的那套已验证写法:
 *   单指拖动 = 平移,双指捏合 = 以两指中点为锚缩放,双击 = 复位。
 *   状态只有一个 scale 与一对 offset,帧内合并用 runtime.createFrameTask。
 */
(function (app) {
  "use strict";

  var root, stage, image, zoom;
  var current = null, scale = 1, offsetX = 0, offsetY = 0;
  var pointers = {}, gesture = null, stageRect = null, task = null;

  function t(zh, en) { return app.i18n.text(zh, en); }
  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function values() {
    return Object.keys(pointers).map(function (key) { return pointers[key]; });
  }
  function distance(a, b) { var x = a.x - b.x, y = a.y - b.y; return Math.sqrt(x * x + y * y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function clampOffset() {
    var width = image && image.clientWidth || 0, height = image && image.clientHeight || 0;
    var limitX = Math.max(0, (width * scale - stage.clientWidth) / 2);
    var limitY = Math.max(0, (height * scale - stage.clientHeight) / 2);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX));
    offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
  }

  function apply() {
    clampOffset();
    if (image) image.style.transform = "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    if (zoom) zoom.textContent = scale === 1 ? t("双击复位", "Double-tap to reset") : Math.round(scale * 100) + "%";
  }

  function reset() {
    scale = 1; offsetX = 0; offsetY = 0; pointers = {}; gesture = null;
    if (task) task.request();
  }

  function beginGesture() {
    var list = values();
    if (list.length >= 2) {
      var center = midpoint(list[0], list[1]), rect = stageRect || stage.getBoundingClientRect();
      gesture = {
        type: "pinch",
        distance: Math.max(1, distance(list[0], list[1])),
        scale: scale,
        localX: (center.x - (rect.left + rect.width / 2) - offsetX) / scale,
        localY: (center.y - (rect.top + rect.height / 2) - offsetY) / scale
      };
    } else if (list.length === 1) {
      gesture = { type: "pan", point: list[0], x: offsetX, y: offsetY };
    } else {
      gesture = null;
    }
  }

  function onDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    stageRect = stage.getBoundingClientRect();
    pointers[event.pointerId === undefined || event.pointerId === null ? "mouse" : event.pointerId] = point(event);
    if (stage.setPointerCapture && event.pointerId !== undefined && event.isTrusted) stage.setPointerCapture(event.pointerId);
    beginGesture();
  }

  function onMove(event) {
    var key = event.pointerId === undefined || event.pointerId === null ? "mouse" : event.pointerId;
    if (!pointers[key]) return;
    event.preventDefault();
    pointers[key] = point(event);
    var list = values();
    if (list.length >= 2) {
      if (!gesture || gesture.type !== "pinch") beginGesture();
      if (!gesture) return;
      var center = midpoint(list[0], list[1]), rect = stageRect || stage.getBoundingClientRect();
      scale = Math.max(1, Math.min(8, gesture.scale * distance(list[0], list[1]) / gesture.distance));
      offsetX = center.x - (rect.left + rect.width / 2) - gesture.localX * scale;
      offsetY = center.y - (rect.top + rect.height / 2) - gesture.localY * scale;
    } else if (gesture && gesture.type === "pan") {
      offsetX = gesture.x + list[0].x - gesture.point.x;
      offsetY = gesture.y + list[0].y - gesture.point.y;
    }
    task.request();
  }

  function onUp(event) {
    delete pointers[event.pointerId === undefined || event.pointerId === null ? "mouse" : event.pointerId];
    if (!values().length) stageRect = null;
    beginGesture();
  }

  function init() {
    root = document.getElementById("render-preview");
    if (!root) return false;
    stage = document.getElementById("render-preview-stage");
    image = document.getElementById("render-preview-image");
    zoom = document.getElementById("render-preview-zoom");
    task = app.runtime.createFrameTask(apply);
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", reset);
    document.getElementById("render-preview-close").onclick = close;
    document.getElementById("render-preview-reset").onclick = reset;
    document.getElementById("render-preview-delete").onclick = app.components.ui.action(remove);
    document.addEventListener("keydown", function (event) {
      if (!root.hidden && event.key === "Escape") close();
    });
    return true;
  }

  function open(result) {
    if (!result || !result.src) return false;
    current = result;
    root.hidden = false;
    image.setAttribute("src", result.src);
    reset();
    return true;
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    image.removeAttribute("src");
    pointers = {}; gesture = null; stageRect = null; scale = 1; offsetX = 0; offsetY = 0;
    if (task) task.cancel();
    current = null;
  }

  /* 删除就发生在全屏里(用户要求:「全屏观看时候可以点击删除」)——
     删完必须自己关掉,否则留在一个指向已删图片的空屏上。 */
  async function remove() {
    var target = current;
    if (!target) return;
    var confirmed = await app.components.ui.confirm({
      title: t("删除这张成图?", "Delete this image?"),
      message: t("删除后无法恢复,作品里的这一张会一起消失。", "This cannot be undone; the image leaves the artwork as well."),
      okText: t("删除", "Delete")
    });
    if (!confirmed) return;
    await app.services.store.removeResult(target.id);
    close();
    app.events.emit("results:changed", { id: target.id });
    app.components.ui.toast(t("已删除这张成图", "Image deleted"));
  }

  app.components.renderPreview = { init: init, open: open, close: close, reset: reset };
})(window.posegi);
