/* 启动与装配
 *
 * 顺序:界面基元 → 配置 → 视口 → 生图编排 → 摆姿 → 页面绑定 → 宿主就绪 → 自检
 * 约束:任何一步失败都要能继续跑完,并留下可读状态,不出现白屏。
 */
(function (app) {
  "use strict";

  /* 视口与摆姿的双向装配
   *
   * 分层约定:components 不反向调用 features,所以两边都只发事件,由这里接起来。
   * 单一环:视口拖拽 → viewport:rotate / viewport:ik → poser 改姿态 → pose:changed → 视口重画。
   * 两种拖拽语义由被点中的东西决定:连接杆(骨杆)是旋转,节点(球)是 IK 移动。
   */
  function wireViewport() {
    var viewport = app.components.viewport;
    var poser = app.features.poser;

    viewport.setPose(poser.angles());
    viewport.setSelectedJoint("");
    viewport.setMode("pose");

    app.events.on("viewport:picked", function (detail) { poser.selectJoint(detail.joint, detail.part); });
    /* 点一下空白 = 取消选择(不动相机的目标点 —— 目标只由"双指平移"和"双击适配"改) */
    app.events.on("viewport:blank", function () { poser.selectJoint("", ""); });
    app.events.on("viewport:rotate", function (detail) { poser.patchJoint(detail.joint, detail.patch); });
    app.events.on("viewport:ik", function (detail) { poser.patchJoints(detail.angles, "ik"); });
    app.events.on("pose:changed", function (detail) { viewport.setPose(detail.angles); });
    app.events.on("pose:selected", function (detail) { viewport.setSelectedJoint(detail.joint, detail.part); });
  }

  /* 锁竖屏。三道一起上,因为各自的生效条件不同:
     1. 清单里的 `display.orientation: "portrait"` 是正门,由宿主执行(官方指南确认过字段名);
     2. 支持 Screen Orientation API 的内核直接 lock 死;宿主不允许时它会 reject,吞掉即可,
        不能让一个"锦上添花"的调用变成未处理拒绝;
     3. 万一上面两道都没生效,横屏时由 CSS 的 .orientation-guard 用整屏提示挡住操作。 */
  function lockPortrait() {
    try {
      var orientation = window.screen && window.screen.orientation;
      if (orientation && typeof orientation.lock === "function") {
        var pending = orientation.lock("portrait");
        if (pending && typeof pending.catch === "function") pending.catch(function () {});
      }
    } catch (error) { /* 不支持就走清单与 CSS */ }
  }

  async function start() {
    app.components.ui.init();
    app.events.on("error", function (error) { app.components.ui.toast(app.utils.cleanError(error), "error"); });

    await app.services.store.loadConfig();
    app.i18n.setLanguage(app.config.preferences.language);
    app.i18n.theme();

    /* 先把配置里记着的造型装进骨架,再建视口 —— 视口初始化时直接读到装好的关节表,
       于是外带模型不需要"先建一遍再换一遍" */
    app.features.figure.init();

    app.components.viewport.init(document.getElementById("stage-viewport"));
    app.components.viewport.setTheme(app.state.theme);
    app.services.imageEngine.init({ capture: app.components.viewport.capture });
    app.features.poser.init();
    wireViewport();
    app.components.gallery.init(document.getElementById("gallery-body"));
    app.components.settings.init();
    app.features.editor.init();
    app.features.editor.status(app.features.editor.defaultStatus());

    app.platform.hermit.appReady();
    app.platform.hermit.reportTheme();
    lockPortrait();

    var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addListener) media.addListener(function () {
      app.components.viewport.setTheme(app.i18n.theme());
    });

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
        selectedPart: app.state.selectedPart,
        poseName: app.state.poseName,
        dirty: app.state.dirty,
        busy: app.state.busy,
        status: app.state.status,
        viewport: { available: viewport.available(), reason: viewport.reason() },
        figure: { id: app.features.figure.current(), figure: viewport.figure() },
        scene: { mode: viewport.mode(), counts: viewport.counts(), view: viewport.view(), body: viewport.body() },
        stage: window.posegiDevState.stage(),
        pose: (function () {
          var angles = app.features.poser.angles();
          var flat = {};
          ["broot", "hips", "spine", "chest", "head", "shoulder.L", "upperArm.L", "forearm.L", "thigh.L", "shin.L", "foot.L"].forEach(function (name) {
            flat[name] = [angles[name].x, angles[name].y, angles[name].z];
          });
          return flat;
        })(),
        bridge: app.platform.hermit.available(),
        scrollY: window.scrollY,
        selfTest: window.__posegiSelfTest || null
      };
    },

    /* 舞台实际占了多少屏 —— "3D 场景占满屏幕"这条要能量出来 */
    stage: function () {
      var host = document.getElementById("stage-viewport");
      var bar = document.querySelector(".topbar");
      if (!host) return null;
      var rect = host.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        topbar: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        windowHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight
      };
    },

    /* 在舞台上撒一个网格,报告每个点会命中谁。
       用来回答"点胳膊腿点不动"到底是命中了什么(空手 = 射线没打到东西)。 */
    hits: function (divisions) {
      var viewport = app.components.viewport;
      var canvas = document.querySelector("#stage-viewport canvas");
      if (!canvas) return null;
      var steps = Number(divisions) > 0 ? Math.round(Number(divisions)) : 6;
      var rect = canvas.getBoundingClientRect();
      var grid = [];
      for (var row = 1; row <= steps; row += 1) {
        var line = [];
        for (var column = 1; column <= steps; column += 1) {
          var x = rect.left + rect.width * column / (steps + 1);
          var y = rect.top + rect.height * row / (steps + 1);
          var hit = viewport.probe(Math.round(x), Math.round(y));
          line.push(hit.joint ? hit.joint + "/" + hit.part : "-");
        }
        grid.push(line.join(" "));
      }
      return { canvas: { width: Math.round(rect.width), height: Math.round(rect.height) }, grid: grid };
    },

    /* 关节(或骨杆末端)在屏幕上的位置。
       拖拽跟不跟手就看这个:手指往哪边拖,屏幕上那个点就得往哪边走。 */
    screenOf: function (name, atTail) {
      var viewport = app.components.viewport;
      if (!viewport.screenOf) return null;
      var point = viewport.screenOf(name, atTail === true);
      if (!point) return null;
      return { x: Math.round(point.x), y: Math.round(point.y) };
    },

    /* 上一次旋转解算的中间量:三个通道每弧度走多少像素、解出来的转角。
       "拖不动"是通道没反应还是方向对不上,看这个就知道。 */
    rotateDebug: function () {
      var viewport = app.components.viewport;
      return viewport.rotateDebug ? viewport.rotateDebug() : null;
    },

    /* 设备端验收:不点界面直接装造型(只有宜家人偶一个,留着是为了能强制重装)。 */
    figure: function (id) {
      var target = id === undefined || id === null ? app.features.figure.current() : String(id);
      return app.features.figure.apply(target, { force: true });
    },

    /* 不点屏幕,直接把两条链路各走一遍:拖连接杆(旋转)与拖节点(IK)。
       姿态真的变了才算通,这样"能不能动"就不必靠目测。 */
    pipeline: function () {
      var poser = app.features.poser;
      var snapshot = function () { return JSON.stringify(poser.angles()); };
      var before = snapshot();
      app.events.emit("viewport:rotate", { joint: "upperArm.L", patch: { x: 45 } });
      var afterRotate = snapshot();
      app.events.emit("viewport:ik", { joint: "hand.L", angles: { "upperArm.R": { x: -35 } } });
      var afterIk = snapshot();
      poser.reset();
      return {
        rotateChanged: before !== afterRotate,
        ikChanged: afterRotate !== afterIk,
        upperArmL: poser.angles()["upperArm.L"].x,
        restored: snapshot() === JSON.stringify(app.rig.defaultAngles())
      };
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.posegi);
