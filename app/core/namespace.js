/* PoseGi 命名空间与全局状态
 *
 * 责任:建立 window.posegi,定义事件总线、运行时状态与默认配置的形状。
 * 约束:只放数据结构与全局单例,不含任何业务逻辑;core 层不碰 DOM。
 */
(function (global) {
  "use strict";

  var app = global.posegi = global.posegi || {};
  var listeners = {};

  app.version = "0.0.5";

  app.events = {
    on: function (name, listener) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (item) { return item !== listener; });
      };
    },
    emit: function (name, detail) {
      (listeners[name] || []).slice().forEach(function (listener) {
        try { listener(detail); } catch (error) { setTimeout(function () { throw error; }, 0); }
      });
    }
  };

  /* 运行时状态:一屏之内的即时值,不直接落盘。 */
  app.state = {
    theme: "light",
    selectedJoint: "",
    selectedPart: "bone",
    poseName: "",
    dirty: false,
    view: { azimuth: 0, elevation: 0, distance: 3.2, targetY: 0.95 },
    busy: false,
    status: "",
    result: null,
    resultImage: null,
    poses: [],
    history: [],
    future: []
  };

  /* 持久化配置:形状固定,字段含义见 README 与各 services 模块。 */
  app.defaults = {
    schema: 1,
    preferences: { theme: "system", language: "zh" },
    render: {
      width: 768,
      height: 1024,
      background: "#f2f3f5",
      /* 默认造型:宜家人偶。取值必须是 app/core/models.js 里登记过的 id,
         不在册的(旧版本存下来的)一律退回这一个(见 features/figure.js)。 */
      character: "ikea",
      showGrid: true,
      showBones: true
    },
    generation: {
      protocol: "sdwebui",
      endpoint: "",
      apiKey: "",
      model: "",
      customHeaders: "",
      prompt: "",
      negativePrompt: "low quality, distorted, extra limbs, watermark, text",
      steps: 24,
      strength: 0.6,
      guidanceScale: 6,
      timeoutMs: 120000
    }
  };

  app.config = null;
  app.platform = {};
  app.services = {};
  app.components = {};
  app.features = {};
})(window);
