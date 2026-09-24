/* 3D 视口:场景、相机、角色、命中检测、截图
 *
 * 责任:唯一接触 three.js 的模块。对外只暴露"放一个姿态进去、拿一张图出来"。
 * 约束:
 *   - 不使用 flex gap 之类的现代布局;视口尺寸由容器决定,ResizeObserver 不可用时退回 resize 事件。
 *   - WebGL 必须特性检测:拿不到上下文时给出可读提示并保持页面可用(app.components.viewport.available() === false)。
 *   - 截图必须在 render 之后同一帧内取,或保持 preserveDrawingBuffer:true,否则拿到空图。
 *
 * 对外接口(契约,尚未实现):
 *   init(container)                 → 建立 renderer / scene / camera / 默认角色
 *   available()                     → WebGL 是否可用
 *   reason()                        → 不可用时的原因文案
 *   setPose(angles, options)        → 应用一组姿态角;options.animate 为真时补间
 *   setSelectedJoint(name)          → 高亮当前关节,并让叠加层跟随
 *   pick(clientX, clientY)          → 返回命中的关节名,未命中返回 ""
 *   capture()                       → { imageBase64, mime, width, height }
 *   frameCamera()                   → 按角色包围盒设置相机取景
 *   dispose()                       → 释放 renderer 与几何体
 *
 * 现状:只做到 WebGL 特性检测与占位提示;场景与角色都没建。
 */
(function (app) {
  "use strict";

  var state = { container: null, canvas: null, available: false, reason: "" };

  function detect() {
    try {
      var probe = document.createElement("canvas");
      var context = probe.getContext("webgl") || probe.getContext("experimental-webgl");
      if (!context) return { available: false, reason: app.i18n.text("这台设备的 WebView 没有可用的 WebGL,3D 视口无法显示", "This WebView has no usable WebGL, so the 3D viewport cannot render") };
      return { available: true, reason: "" };
    } catch (error) {
      return { available: false, reason: app.i18n.text("WebGL 初始化失败:" + app.utils.cleanError(error), "WebGL failed to start: " + app.utils.cleanError(error)) };
    }
  }

  function init(container) {
    state.container = container || state.container;
    var result = detect();
    state.available = result.available;
    state.reason = result.reason;
    if (!state.available) {
      if (state.container) {
        var hint = document.getElementById("stage-fallback");
        if (hint) {
          hint.hidden = false;
          hint.textContent = state.reason;
        }
      }
      app.events.emit("viewport:unavailable", { reason: state.reason });
      return false;
    }
    /* TODO(场景):renderer + scene + 灯光 + 网格 + OrbitControls + 按 app.rig 生成胶囊骨骼 */
    app.events.emit("viewport:ready", { version: app.version, three: window.THREE ? window.THREE.REVISION : "" });
    return true;
  }

  function notImplemented(name) {
    return function () { throw new Error(name + " 尚未实现:3D 场景还没建"); };
  }

  app.components.viewport = {
    init: init,
    available: function () { return state.available; },
    reason: function () { return state.reason; },
    setPose: notImplemented("应用姿态"),
    setSelectedJoint: notImplemented("高亮关节"),
    pick: notImplemented("关节命中检测"),
    capture: notImplemented("截取渲染图"),
    frameCamera: notImplemented("取景"),
    dispose: notImplemented("释放视口")
  };
})(window.posegi);
