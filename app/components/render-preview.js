/* 成图全屏查看:高度充满、拖动平移、双指放缩、底部调色面板、删除
 *
 * 责任:把一张成图铺满整屏给人看,让人在看的时候就能调色、就能删掉它。
 * 约束:整层挂在 body 上(不放进任何 flex 父级),用 fixed 铺满视口 ——
 *       弹层用的是 flex 布局,如果这层住在里面会被父级的尺寸约束住(hamdraw 踩过,专门写了 !important 修正)。
 *
 * ---------- 显示面是画布,不是 img ----------
 *
 * 用户 2026-09-30 要求:「渲染图全屏查看的时候,高度要默认充满窗口显示」,并且加调色工具。
 * 这两件事一起把显示面从 `<img>` 换成 `<canvas>`:
 *   - **高度充满**靠 CSS 一条 `height:100%`(宽度按图片自己的比例算出来),
 *     9:16 的竖图在更"方"的屏幕上因此会横向溢出到画面外,这正是要的 ——
 *     屏幕上看到的是"整高 + 左右裁掉一点",而不是"缩到两边留白"。
 *   - **调色**要有像素:颜色四项可以走 CSS 滤镜,但清晰度在 CSS 里没有对应物
 *     (见 services/render-adjust.js 的注释)。画布是唯一能一次把六项都做掉的地方。
 * `<img>` 留着当**解码源**(画布需要一张已经解好码的图),但它自己不显示。
 *
 * ---------- 手势 ----------
 *
 * 交互照搬 hamdraw 的那套已验证写法:
 *   单指拖动 = 平移,双指捏合 = 以两指中点为锚缩放,双击 = 复位。
 *   状态只有一个 scale 与一对 offset,帧内合并用 runtime.createFrameTask。
 * **缩放下限是 1,而 1 就是"高度正好充满"** —— 用户明确要求「最小也要高度充满」,
 * 所以再往外捏不会缩成一张居中的小图,只是把手挪开也没有余量可滑。
 */
(function (app) {
  "use strict";

  var root, stage, source, surface, zoom, panel, adjustButton;
  var current = null, scale = 1, offsetX = 0, offsetY = 0;
  var pointers = {}, gesture = null, stageRect = null, transformTask = null, paintTask = null;
  var sourceReady = false;
  /* 这一份是**活的那一份**(调色参数的唯一持有者):作品文档里存的是它的快照
     (见 app.js 的 wireWorkDocument),装回来时由 setAdjustments 推回这里。 */
  var adjust = app.services.renderAdjust;
  var adjustments = adjust.normalize(null);

  function t(zh, en) { return app.i18n.text(zh, en); }
  function esc(value) { return app.utils.escapeHtml(value); }
  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function values() {
    return Object.keys(pointers).map(function (key) { return pointers[key]; });
  }
  function distance(a, b) { var x = a.x - b.x, y = a.y - b.y; return Math.sqrt(x * x + y * y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  /* 平移的余量 = (显示面尺寸 × 当前倍数 − 舞台尺寸) / 2,负数一律夹成 0。
     高度充满之后,scale=1 时纵向余量正好是 0(压不动)、横向余量是溢出屏幕的那部分(可以左右挪)——
     这就是"最小也要高度充满"在数据上的样子。
     与 zoomScale 一样单独写成函数并露出去:写在 clampOffset 里的话没有任何测试够得着。 */
  function panLimit(size, stageSize, currentScale) {
    return Math.max(0, (size * currentScale - stageSize) / 2);
  }

  function clampOffset() {
    var limitX = panLimit(surface && surface.clientWidth || 0, stage.clientWidth, scale);
    var limitY = panLimit(surface && surface.clientHeight || 0, stage.clientHeight, scale);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX));
    offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
  }

  function apply() {
    clampOffset();
    if (surface) surface.style.transform = "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    /* 顶部那一行:2026-09-30 用户要求「顶部不要显示提示文字「双击复位」」——
       所以 100% 时它**什么都不显示**(空串),只有真的缩放了才报一个百分比。
       元素本身留着(不删):它同时是"现在放多大"的唯一读数,而且是绝对定位的浮层,
       空着既不占位也不挡手势;手势本身没变,双击照样复位。 */
    if (zoom) zoom.textContent = scale === 1 ? "" : Math.round(scale * 100) + "%";
  }

  function reset() {
    scale = 1; offsetX = 0; offsetY = 0; pointers = {}; gesture = null;
    if (transformTask) transformTask.request();
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

  /* 缩放下限恒为 1 = **高度充满**(用户 2026-09-30 要求「最小也要高度充满」),上限 8 倍够看清毛孔。
     单独写成函数并露出去,是为了让"下限真的是 1"有一条测试守着 —— 它原来写在 onMove 里,
     而 onMove 要真 DOM 与真指针事件才跑得起来,把它悄悄改成 0.5 不会有任何东西变红。 */
  function zoomScale(startScale, startDistance, nowDistance) {
    var grown = startDistance > 0 ? startScale * nowDistance / startDistance : startScale;
    return Math.max(1, Math.min(8, grown));
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
      scale = zoomScale(gesture.scale, gesture.distance, distance(list[0], list[1]));
      offsetX = center.x - (rect.left + rect.width / 2) - gesture.localX * scale;
      offsetY = center.y - (rect.top + rect.height / 2) - gesture.localY * scale;
    } else if (gesture && gesture.type === "pan") {
      offsetX = gesture.x + list[0].x - gesture.point.x;
      offsetY = gesture.y + list[0].y - gesture.point.y;
    }
    if (transformTask) transformTask.request();
  }

  function onUp(event) {
    delete pointers[event.pointerId === undefined || event.pointerId === null ? "mouse" : event.pointerId];
    if (!values().length) stageRect = null;
    beginGesture();
  }

  /* ---------- 底部调色面板 ----------
   * 2026-09-30 用户要求:「添加调色工具,参照 HamDraw 的全屏渲染图查看界面的底部调色面板,
   * 调色参数也要保存到作品文档」。
   * **六个滑杆 + 两个动作**都由 adjust.KEYS / adjust.RANGE 生成 —— 参数表、行程、后缀
   * 全在 services/render-adjust.js 一处,这里只负责把标签翻译出来并拼成 DOM。
   * 两列而不是三列:手机上三列会把「对比度」「梦幻辉光」这类三字标签折成两行,
   * 而滑杆只剩一条缝可用(见 components.css)。
   * **没有「保存默认」** —— HamDraw 那一份存的是全局默认,而这里的参数跟着作品走。 */
  function panelHtml() {
    var sliders = adjust.KEYS.map(function (key) {
      var range = adjust.RANGE[key];
      var label = t(range.zh, range.en);
      return '<label class="color-adjust-item"><span><span>' + esc(label) + "</span>" +
        '<output data-adjust-output="' + key + '"></output></span>' +
        '<input type="range" min="' + range.min + '" max="' + range.max + '" step="1" data-adjust="' + key +
        '" data-suffix="' + esc(range.suffix) + '" aria-label="' + esc(label) + '"></label>';
    }).join("");
    return sliders +
      '<div class="render-preview-adjust-actions">' +
      '<button class="button button-secondary" type="button" data-adjust-action="reset">' +
      '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>' + t("重置", "Reset") + "</button>" +
      /* 开关放在最右:滑杆全回中性之后,它是唯一还能看出"调色到底有没有生效"的东西 ——
         也是唯一能把两张图并排比出来的办法。 */
      '<label class="render-preview-switch"><span>' + t("调色效果", "Color effect") + "</span>" +
      '<input type="checkbox" role="switch" data-adjust-enabled></label>' +
      "</div>";
  }

  /* 把面板刷成这一份参数。找不到的滑杆跳过 —— 面板只在全屏看图里存在。 */
  function paintPanel() {
    if (!panel) return;
    adjust.KEYS.forEach(function (key) {
      var input = panel.querySelector('[data-adjust="' + key + '"]');
      if (!input) return;
      /* 手指正在滑杆上时不去动它(与关节面板同一条规矩,否则会被自己拖回去) */
      if (document.activeElement !== input) input.value = String(adjustments[key]);
      var output = panel.querySelector('[data-adjust-output="' + key + '"]');
      if (output) output.textContent = adjust.display(key, adjustments[key]);
    });
    var toggle = panel.querySelector("[data-adjust-enabled]");
    if (toggle) toggle.checked = adjustments.enabled !== false;
  }

  /* ---------- 显示面 ---------- */

  function drawSurface() {
    if (!sourceReady || !surface || !source) return false;
    /* 拖动期间那一帧走"草稿"(见 render-adjust 的 DRAFT_SCALE):**降不降分辨率由
       render-adjust 自己判** —— 只有这一帧真的要跑逐像素那一遍时才降。 */
    surface.hidden = !adjust.draw(surface, source, adjustments, { draft: drafting });
    apply();
    return !surface.hidden;
  }

  /* ---------- 拖动中的草稿与收尾 ----------
   *
   * 用户 2026-09-30 要求:「全屏查看渲染图界面的调色滑竿现在很卡,请想办法优化算法或机制」。
   * 最主要的一刀在 render-adjust(清晰度那一步改成缓存 + 先锐化后颜色:拖颜色时一次像素都不碰)。
   * 这里管剩下的一半:清晰度自己变了 —— 那一遍一定要跑,那就**先出低分辨率草稿**,
   * 手指停住之后再补一帧完整分辨率的。
   *
   * 为什么要"停住"这个动作:滑杆的 input 是一串爆发式的连续事件,每一帧都出全质量
   * 就等于每一帧都付一次逐像素的代价(手机上 100ms 级),那必然卡;而手指停下来之后
   * 只补一帧,用户看不出中间过程,最后落在屏幕上的那张仍然是完整分辨率的。
   *
   * 一次性动作(重置 / 调色开关)不走草稿:它们只画一帧,没必要先糊一下再变清楚。 */
  var DRAFT_SETTLE_MS = 160;
  var settleTimer = 0, drafting = false;

  function endDraft() {
    settleTimer = 0;
    if (!drafting) return;
    drafting = false;
    if (paintTask) paintTask.request();
  }

  function beginDraft() {
    drafting = true;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(endDraft, DRAFT_SETTLE_MS);
  }

  function syncPanel() {
    if (!panel) return;
    /* 工具条那颗按钮的"正在生效"记号:面板开着**而且**确实有一套调色压在上面。
       中性时不给记号 —— 那时点开面板什么也不会变,不该看起来像"开着"。 */
    if (adjustButton) adjustButton.classList.toggle("is-on", !panel.hidden && !adjust.isNeutral(adjustments));
  }

  /* 参数一变就报出去(装配层把它写进当前作品并安排落盘),顺手重画。
     画布重绘走帧任务:拖滑杆时每一帧可能要重新锐化一遍整幅像素,不合并会卡。
     draft 只由**滑杆**传 true —— 见上面那段。 */
  function pushAdjustments(draft) {
    if (draft) beginDraft();
    if (paintTask) paintTask.request();
    paintPanel();
    syncPanel();
    app.events.emit("render:adjusted", app.utils.copy(adjustments));
  }

  /* 从作品文档装回来的一份。**不回报事件** —— 那份值本来就是从作品来的,
     再报一次就是一个"打开作品 ⇒ 写作品 ⇒ 打开作品"的环。 */
  function setAdjustments(raw) {
    adjustments = adjust.normalize(raw);
    paintPanel();
    syncPanel();
    if (root && !root.hidden && paintTask) paintTask.request();
    return app.utils.copy(adjustments);
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    if (adjustButton) adjustButton.setAttribute("aria-expanded", "false");
    syncPanel();
  }

  function togglePanel() {
    if (!panel || !adjustButton) return;
    panel.hidden = !panel.hidden;
    adjustButton.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    syncPanel();
  }

  function init() {
    root = document.getElementById("render-preview");
    if (!root) return false;
    stage = document.getElementById("render-preview-stage");
    source = document.getElementById("render-preview-source");
    surface = document.getElementById("render-preview-surface");
    zoom = document.getElementById("render-preview-zoom");
    panel = document.getElementById("render-preview-adjustments");
    adjustButton = document.getElementById("render-preview-adjust");

    transformTask = app.runtime.createFrameTask(apply);
    paintTask = app.runtime.createFrameTask(drawSurface);

    if (panel) panel.innerHTML = panelHtml();
    paintPanel();

    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", reset);
    document.getElementById("render-preview-close").onclick = close;
    document.getElementById("render-preview-reset").onclick = reset;
    document.getElementById("render-preview-delete").onclick = app.components.ui.action(remove);
    if (adjustButton) adjustButton.onclick = togglePanel;

    adjust.KEYS.forEach(function (key) {
      var input = panel && panel.querySelector('[data-adjust="' + key + '"]');
      if (!input) return;
      input.addEventListener("input", function () {
        var value = app.utils.finiteNumber(input.value);
        adjustments[key] = value === null ? adjust.DEFAULTS[key] : value;
        var output = panel.querySelector('[data-adjust-output="' + key + '"]');
        if (output) output.textContent = adjust.display(key, adjustments[key]);
        /* 滑杆是连续事件 ⇒ 走草稿帧,手指停住后再补一帧完整分辨率的 */
        pushAdjustments(true);
      });
    });
    var enabled = panel && panel.querySelector("[data-adjust-enabled]");
    if (enabled) enabled.onchange = function () {
      adjustments.enabled = enabled.checked !== false;
      pushAdjustments();
    };
    var resetAdjust = panel && panel.querySelector('[data-adjust-action="reset"]');
    if (resetAdjust) resetAdjust.onclick = function () {
      adjustments = adjust.normalize(null);
      pushAdjustments();
    };

    source.onload = function () {
      if (!current || source.getAttribute("src") !== current.src) return;
      sourceReady = true;
      surface.style.transform = "";
      drawSurface();
      reset();
    };
    source.onerror = function () {
      if (!current || source.getAttribute("src") !== current.src) return;
      sourceReady = false;
      if (surface) surface.hidden = true;
    };

    document.addEventListener("keydown", function (event) {
      if (root.hidden) return;
      if (event.key === "Escape") {
        /* 面板开着时先收面板 —— 一次返回只做一件事,和系统返回键的习惯一致 */
        if (panel && !panel.hidden) closePanel();
        else close();
      }
    });
    return true;
  }

  function open(result) {
    if (!result || !result.src) return false;
    current = result;
    root.hidden = false;
    closePanel();
    sourceReady = false;
    if (surface) surface.hidden = true;
    source.removeAttribute("src");
    surface.style.transform = "";
    reset();
    source.setAttribute("src", result.src);
    return true;
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    closePanel();
    source.removeAttribute("src");
    sourceReady = false;
    if (surface) surface.hidden = true;
    pointers = {}; gesture = null; stageRect = null; scale = 1; offsetX = 0; offsetY = 0;
    if (transformTask) transformTask.cancel();
    if (paintTask) paintTask.cancel();
    /* 收尾那一帧要跟着取消:关掉之后再去画一次全分辨率,白花一次逐像素的代价,
       而且画的是一张已经不在屏上的画布。 */
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = 0;
    drafting = false;
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

  app.components.renderPreview = {
    init: init,
    open: open,
    close: close,
    reset: reset,
    /* 作品文档的两个方向:取数口给 store,装回来由装配层调 setAdjustments */
    adjustments: function () { return app.utils.copy(adjustments); },
    setAdjustments: setAdjustments,
    /* 手势的两个纯算式(不碰 DOM)。"最小也要高度充满"这条要求就落在它们身上,
       藏在 onMove / clampOffset 里的话测试够不着 —— 那是这条要求唯一可能悄悄丢掉的地方。 */
    zoomScale: zoomScale,
    panLimit: panLimit
  };
})(window.posegi);
