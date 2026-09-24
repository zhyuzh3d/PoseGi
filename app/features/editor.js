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
    return app.i18n.text("框架阶段:3D 视口与生图链路尚未实现", "Framework stage: the 3D viewport and generation pipeline are not implemented yet");
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
    bindGeneration();
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
