/* 启动与装配
 *
 * 顺序:界面基元 → 配置 → 视口 → 生图编排 → 摆姿 → 页面绑定 → 宿主就绪 → 自检
 * 约束:任何一步失败都要能继续跑完,并留下可读状态,不出现白屏。
 */
(function (app) {
  "use strict";

  async function start() {
    app.components.ui.init();
    app.events.on("error", function (error) { app.components.ui.toast(app.utils.cleanError(error), "error"); });

    await app.services.store.loadConfig();
    app.i18n.setLanguage(app.config.preferences.language);
    app.i18n.theme();

    app.components.viewport.init(document.getElementById("stage-viewport"));
    app.services.imageEngine.init({ capture: app.components.viewport.capture });
    app.features.poser.init();
    app.components.gallery.init(document.getElementById("gallery-body"));
    app.components.settings.init();
    app.features.editor.init();
    app.features.editor.status(app.features.editor.defaultStatus());

    app.platform.hermit.appReady();
    app.platform.hermit.reportTheme();

    var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addListener) media.addListener(app.i18n.theme);

    await app.features.selfTest.run();
  }

  window.addEventListener("error", function (event) {
    if (event.error) app.events.emit("error", event.error);
  });
  window.addEventListener("unhandledrejection", function (event) {
    app.events.emit("error", event.reason || new Error("异步操作失败"));
  });

  /* 设备端验收用的可读状态:hermit_get_page_state 读这里的第二个返回值 */
  window.posegiDevState = {
    capture: function () {
      var viewport = app.components.viewport;
      return {
        version: app.version,
        theme: document.documentElement.dataset.theme,
        language: app.i18n.language(),
        selectedJoint: app.state.selectedJoint,
        poseName: app.state.poseName,
        dirty: app.state.dirty,
        busy: app.state.busy,
        status: app.state.status,
        viewport: { available: viewport.available(), reason: viewport.reason() },
        bridge: app.platform.hermit.available(),
        scrollY: window.scrollY,
        selfTest: window.__posegiSelfTest || null
      };
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.posegi);
