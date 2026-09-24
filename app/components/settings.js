/* 设置:生图接口、渲染参数、偏好
 *
 * 责任:把 app.config 渲染成表单并写回,字段由 services/providers 的 fields 决定。
 * 约束:API Key 输入框默认遮罩(type=password),不写入日志与测试;选择项不用原生 select。
 *
 * 现状:骨架。openModels / openPreferences 只提示尚未实现。
 */
(function (app) {
  "use strict";

  function init() { return true; }

  function openModels() {
    app.components.ui.openSheet({
      eyebrow: app.i18n.text("生成", "Generation"),
      title: app.i18n.text("生图接口", "Image service"),
      bodyHtml: '<p class="sheet-note">' + app.i18n.text(
        "接口配置待实现。计划支持:Stable Diffusion WebUI / Forge、ComfyUI(需工作流)、OpenAI Images 兼容。",
        "Not implemented yet. Planned: Stable Diffusion WebUI / Forge, ComfyUI (needs a workflow), OpenAI Images compatible."
      ) + "</p>"
    });
  }

  function openPreferences() {
    app.components.ui.openSheet({
      eyebrow: app.i18n.text("偏好", "Preferences"),
      title: app.i18n.text("软件设置", "Preferences"),
      bodyHtml: '<p class="sheet-note">' + app.i18n.text("偏好设置待实现:主题、语言、画布网格与骨骼显示。", "Not implemented yet: theme, language, grid and bone visibility.") + "</p>"
    });
  }

  app.components.settings = { init: init, openModels: openModels, openPreferences: openPreferences };
})(window.posegi);
