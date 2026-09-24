/* 生图编排:截图 → 组装请求 → 调用 → 落地结果
 *
 * 责任:串起 viewport 的截图、providers 的协议翻译、platform 的请求与 store 的落地。
 * 事件契约(其它模块只依赖这些事件,不直接调用内部函数):
 *   generation:start    { startedAt }
 *   generation:progress { stage, detail }
 *   generation:done     { imageBase64, mime, prompt, poseName }
 *   generation:error    { error }
 *
 * 依赖注入:init({ capture }) —— capture() 返回 { imageBase64, mime, width, height },
 * 由 app/app.js 把 components.viewport.capture 传进来,避免本模块直接依赖渲染层。
 *
 * 现状:骨架。除截图之外的全部步骤都还没实现。
 */
(function (app) {
  "use strict";

  var capture = null;

  function init(options) {
    capture = options && typeof options.capture === "function" ? options.capture : null;
    return api;
  }

  function progress(stage, detail) {
    app.events.emit("generation:progress", { stage: stage, detail: detail || "" });
  }

  function jobFrom(state, config, shot) {
    var generation = config.generation;
    return {
      protocol: generation.protocol,
      endpoint: generation.endpoint,
      apiKey: generation.apiKey,
      model: generation.model,
      customHeaders: generation.customHeaders,
      prompt: generation.prompt,
      negativePrompt: generation.negativePrompt,
      steps: generation.steps,
      strength: generation.strength,
      guidanceScale: generation.guidanceScale,
      width: config.render.width,
      height: config.render.height,
      timeoutMs: generation.timeoutMs,
      imageBase64: shot.imageBase64,
      mime: shot.mime,
      poseName: state.poseName
    };
  }

  async function run() {
    app.events.emit("generation:start", { startedAt: Date.now() });
    try {
      if (!capture) throw new Error("生图编排尚未接入 3D 视口");
      throw new Error("生图链路尚未实现:先把 providers 的适配器与截图接上");
      /* 计划中的流程,实现时按此顺序接:
         1. var shot = capture();                         // 截图
         2. progress("upload", ...);                       // 组装 job
         3. var request = app.services.providers.build(jobFrom(app.state, app.config, shot));
         4. var response = await app.platform.hermit.request(request);
         5. var data = app.utils.parseJson(response.bodyText || "", null);
         6. var image = app.services.providers.parse(job.protocol, data);
         7. app.events.emit("generation:done", {...});     // 结果落盘交给调用方
      */
    } catch (error) {
      app.events.emit("generation:error", { error: error });
      throw error;
    }
  }

  var api = { init: init, run: run, progress: progress };
  app.services.imageEngine = api;
})(window.posegi);
