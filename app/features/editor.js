/* 页面装配:把当前 index.html 上的按钮接到接口上
 *
 * 责任:绑定 DOM 事件、更新状态行、把错误变成提示。不承载业务规则。
 * 约定:所有可点元素都带 data-menu / data-pose / data-action,便于 verify.mjs 断言。
 *
 * 现状:骨架。摆姿面板、生图面板、作品库面板都还没建,现有按钮只接最小闭环。
 */
(function (app) {
  "use strict";

  function node(id) { return document.getElementById(id); }

  function status(message) {
    app.state.status = String(message || "");
    var line = node("status-line");
    if (line) line.textContent = app.state.status;
    return app.state.status;
  }

  function defaultStatus() {
    return app.i18n.text("拖动关节摆姿势,拖空白处转视角;点\"搬运\"整体移动小人", "Drag a joint to pose, drag the background to orbit; tap Move to shift the whole figure");
  }

  function bindMenu() {
    var button = node("open-menu");
    var menu = node("app-menu");
    if (!button || !menu) return;
    button.onclick = function () {
      var open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    menu.addEventListener("click", function (event) {
      var target = event.target.closest("[data-menu]");
      if (!target) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      var action = target.dataset.menu;
      if (action === "models") app.components.settings.openModels();
      if (action === "preferences") app.components.settings.openPreferences();
      if (action === "poses" || action === "results") {
        app.components.ui.toast(app.i18n.text("这部分还没实现,当前是框架阶段", "Not implemented yet, this is still the framework stage"));
      }
      if (action === "help") openHelp();
      if (action === "about") openAbout();
    });
  }

  function bindPoseBar() {
    var presets = document.querySelectorAll("[data-pose]");
    Array.prototype.forEach.call(presets, function (button) {
      button.onclick = function () {
        app.features.poser.applyPreset(button.dataset.pose);
        status(app.i18n.text("已套用预设:", "Preset applied: ") + app.i18n.text(button.dataset.zh, button.dataset.en));
      };
    });
    var mirror = node("pose-mirror");
    if (mirror) mirror.onclick = function () {
      app.features.poser.mirror();
      status(app.i18n.text("已左右镜像", "Pose mirrored"));
    };
    var reset = node("pose-reset");
    if (reset) reset.onclick = function () {
      app.features.poser.reset();
      status(app.i18n.text("已回到默认站姿", "Back to the default stand"));
    };
  }

  var AXIS_LABEL = [
    { key: "x", zh: "屈伸", en: "Bend" },
    { key: "y", zh: "自转", en: "Twist" },
    { key: "z", zh: "侧摆", en: "Splay" }
  ];

  function jointLabel(name) {
    var joint = app.rig.byName(name);
    if (!joint) return name;
    return app.i18n.text(joint.label[0], joint.label[1]);
  }

  /* 关节面板:选中谁就只显示谁的三条通道。拖视口是主路径,滑杆用来微调与读数值。 */
  function renderJointPanel(name) {
    var panel = node("joint-panel");
    if (!panel) return;
    var joint = app.rig.byName(name);
    if (!joint) {
      panel.classList.remove("is-active");
      panel.innerHTML = '<span class="joint-empty">' + app.i18n.text(
        "点视口里的小人选中一个关节,或直接拖动关节摆姿势",
        "Tap a joint on the figure, or drag a joint to pose it"
      ) + "</span>";
      return;
    }
    panel.classList.add("is-active");
    var angles = app.features.poser.angles()[name];
    var html = '<div class="joint-head"><strong>' + jointLabel(name) + "</strong><code>" + name + "</code>" +
      '<button class="joint-close" type="button" data-action="deselect">' +
      app.i18n.text("收起", "Close") + "</button></div>";
    AXIS_LABEL.forEach(function (axis) {
      html += '<div class="axis-row"><label>' + app.i18n.text(axis.zh, axis.en) + "</label>" +
        '<input type="range" min="-180" max="180" step="1" data-axis="' + axis.key + '" value="' +
        Math.round(angles[axis.key]) + '"><output>' + Math.round(angles[axis.key]) + "°</output></div>";
    });
    panel.innerHTML = html;

    var sliders = panel.querySelectorAll("input[data-axis]");
    Array.prototype.forEach.call(sliders, function (slider) {
      slider.oninput = function () {
        var value = app.features.poser.setJointAngle(name, slider.dataset.axis, Number(slider.value));
        var output = slider.parentNode.querySelector("output");
        if (output) output.textContent = Math.round(value) + "°";
      };
    });
    var close = panel.querySelector('[data-action="deselect"]');
    if (close) close.onclick = function () { app.features.poser.selectJoint(""); };
  }

  /* 拖拽与滑杆都会改角度,统一在这里刷新数值,避免滑杆与视口打架 */
  function syncJointPanel() {
    var panel = node("joint-panel");
    if (!panel || !app.state.selectedJoint) return;
    var angles = app.features.poser.angles()[app.state.selectedJoint];
    if (!angles) return;
    var sliders = panel.querySelectorAll("input[data-axis]");
    Array.prototype.forEach.call(sliders, function (slider) {
      var value = Math.round(angles[slider.dataset.axis]);
      if (document.activeElement !== slider) slider.value = String(value);
      var output = slider.parentNode.querySelector("output");
      if (output && document.activeElement !== slider) output.textContent = value + "°";
    });
  }

  function bindMoveBar() {
    var move = node("pose-move");
    if (move) move.onclick = function () {
      var next = app.components.viewport.mode() === "move" ? "pose" : "move";
      app.components.viewport.setMode(next);
      move.classList.toggle("is-on", next === "move");
      status(next === "move"
        ? app.i18n.text("搬运模式:拖动小人整体平移,姿态不变", "Move mode: drag the figure around, the pose stays as is")
        : app.i18n.text("造型模式:拖动关节摆姿势", "Pose mode: drag joints to pose"));
    };
    var fit = node("pose-fit");
    if (fit) fit.onclick = function () {
      app.components.viewport.frameCamera();
      status(app.i18n.text("已重新取景", "Camera reframed"));
    };
  }

  function bindPoseEvents() {
    app.events.on("pose:selected", function (detail) {
      renderJointPanel(detail.joint);
    });
    app.events.on("pose:changed", function () {
      syncJointPanel();
    });
    app.events.on("viewport:unavailable", function (detail) {
      status(detail.reason);
    });
    app.events.on("viewport:lost", function (detail) {
      status(detail.reason);
    });
    app.events.on("viewport:restored", function () {
      status(app.i18n.text("图形上下文已恢复", "Graphics context restored"));
    });
  }

  function bindGeneration() {
    var generate = node("generate");
    if (!generate) return;
    generate.onclick = function () {
      app.services.imageEngine.run().catch(function (error) {
        app.components.ui.toast(app.utils.cleanError(error), "error");
        status(app.utils.cleanError(error));
      });
    };
  }

  function openHelp() {
    app.components.ui.openSheet({
      eyebrow: app.i18n.text("说明", "Guide"),
      title: app.i18n.text("怎么用", "How it works"),
      bodyHtml: '<p class="sheet-note">' + app.i18n.text(
        "1. 在 3D 视口里点选关节;2. 用滑杆摆出造型;3. 点生成,把截图交给本地生图服务。当前为框架阶段,这三步都还没接上。",
        "1. Tap a joint in the 3D viewport; 2. pose it with the sliders; 3. press Generate to send the screenshot to your local image service. This is still the framework stage, so none of the three is wired yet."
      ) + "</p>"
    });
  }

  function openAbout() {
    app.components.ui.openSheet({
      eyebrow: app.i18n.text("关于", "About"),
      title: "PoseGi " + app.version,
      bodyHtml: '<p class="sheet-note">' + app.i18n.text(
        "Hermit 上的 3D 摆姿 happ,手动摆放人形骨骼后交给本地大模型生图。MIT 许可。",
        "A 3D posing happ for Hermit: pose a humanoid rig by hand, then render it with a local image model. MIT licensed."
      ) + '</p><p class="sheet-note">github.com/zhyuzh3d/PoseGi</p>'
    });
  }

  function init() {
    app.i18n.apply();
    bindMenu();
    bindPoseBar();
    bindMoveBar();
    bindPoseEvents();
    bindGeneration();
    renderJointPanel("");
    var version = node("app-version");
    if (version) version.textContent = "v" + app.version;
    return true;
  }

  app.features.editor = {
    init: init,
    status: status,
    defaultStatus: defaultStatus,
    openHelp: openHelp,
    openAbout: openAbout
  };
})(window.posegi);
