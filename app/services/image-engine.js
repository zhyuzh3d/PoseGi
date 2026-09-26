/* 生图编排:截图 → 组装请求 → 调用 → 落地结果
 *
 * 责任:串起 viewport 的截图、providers 的协议翻译、platform 的请求与 store 的落地。
 * 事件契约(其它模块只依赖这些事件,不直接调用内部函数):
 *   generation:start    { model }
 *   generation:progress { stage, detail }
 *   generation:done     { image }
 *   generation:error    { error }
 *   generation:idle     无论成功、失败还是被取消,等待都结束了
 *
 * 依赖注入:init({ capture }) —— capture(size) 返回 { dataUrl, mime, width, height },
 * 由 app/app.js 把 viewport.captureAt 包一层传进来,避免本模块直接依赖渲染层。
 *
 * 两个关键口径:
 *   1) **参考图永远是 1024 边**(app.config.reference.size)。姿态渲染图是给模型的
 *      "内容依据",它不该随模型卡画幅变化 —— 换了张 512 的卡,模型看到的仍该是同一张图。
 *   2) **取消 = 忽略这次等待**(用户原话:「点击就忽略刚才发起的生成」)。
 *      服务端的任务我们停不掉(插件不保证可中断),所以只保证"结果不再落到作品里"。
 */
(function (app) {
  "use strict";

  var capture = null;
  var running = false;
  var generation = 0;
  var dismissed = false;

  function t(zh, en) { return app.i18n.text(zh, en); }

  function init(options) {
    capture = options && typeof options.capture === "function" ? options.capture : null;
    return api;
  }

  function progress(stage, detail) {
    app.events.emit("generation:progress", { stage: stage, detail: detail || "" });
  }

  function configured() {
    var model = app.services.providers.active();
    return Boolean(model && String(model.endpoint || "").trim());
  }

  function withDeadline(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(t("生成等待超时,已结束本次等待;服务端任务可能仍在运行,请稍后再试",
          "Generation timed out and this wait was closed. The server job may still be running; try again shortly.")));
      }, timeoutMs);
      promise.then(function (value) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    });
  }

  function overallTimeout(model) {
    var value = Number(model && model.timeoutMs) || 120000;
    return Math.max(15000, Math.min(330000, value + 20000));
  }

  function cancel() {
    generation += 1;
    dismissed = true;
    running = false;
    app.state.busy = false;
    app.events.emit("generation:idle", { cancelled: true });
  }

  /* 生图前的提示词准备:译英(2026-09-25 用户要求)。
     只对"标了需要英文"的模型卡做,而且只在提示词里真的有中文的时候。
     这一步失败绝不拦生成 —— 插件端自己也会译英,退回原文最多是画得差一点,
     报错拦下就变成"按钮点了没反应",那才是更坏的结果。
     空提示词是允许的(用户要求「提示词可以为空」):这时不翻,按参考图直接出图。 */
  async function prepare(model, prompt) {
    if (!prompt || !app.services.translate.needed(model) || !app.services.translate.hasCjk(prompt)) return prompt;
    if (!app.services.translate.ready()) {
      progress("translate", t("这张卡需要英文提示词,但译英服务还没配置好,这次直接按原文生成",
        "This card wants an English prompt, but the translator is not set up yet; sending the text as-is."));
      return prompt;
    }
    progress("translate", t("正在把角色描述译成英文…", "Translating the description into English…"));
    await app.services.translate.translate([prompt]);
    var english = app.services.translate.english(prompt);
    if (!english || english === prompt) return prompt;
    /* 译文存进作品:作品列表的编辑界面据此显示 —— 不这么做的话换个进程就只剩原文,
       用户看不出"生图时到底发了什么"。 */
    app.state.promptEn = app.services.translate.pair(prompt, english);
    app.services.store.scheduleSave();
    app.events.emit("prompt:translated", { source: prompt, text: english });
    return english;
  }

  async function run() {
    if (running) {
      progress("queued", t("上一次生成还没结束,请稍候", "The previous generation is still running"));
      return null;
    }
    var model = app.services.providers.active();
    if (!model) throw new Error(t("还没有模型卡,请先在「添加模型」里建一张", "No model card yet. Add one under Add model first."));
    app.services.providers.validate(model);
    if (!capture) throw new Error(t("生图编排尚未接入 3D 视口", "The generation pipeline is not wired to the 3D viewport"));

    var prompt = String(app.state.prompt || "").trim();
    var negativePrompt = String(app.state.negativePrompt || "").trim();

    running = true;
    dismissed = false;
    var token = ++generation;
    var succeeded = false;
    app.state.busy = true;
    app.events.emit("generation:start", { model: { id: model.id, name: model.name, protocol: model.protocol } });
    try {
      prompt = await prepare(model, prompt);
      progress("capture", t("正在渲染 " + app.config.reference.size + " 参考图…", "Rendering a " + app.config.reference.size + "-pixel reference…"));
      var shot = await capture(app.config.reference.size);
      if (token !== generation) return null;
      var input = {
        prompt: prompt,
        negativePrompt: negativePrompt,
        seed: -1,
        imageDataUrl: shot.dataUrl,
        mime: shot.mime
      };
      var result = await withDeadline(app.services.providers.generate(model, input), overallTimeout(model));
      if (token !== generation) return null;
      progress("store", t("正在保存成图…", "Saving the image…"));
      var asset = null;
      try { asset = await app.services.assets.persist(result.src, null); } catch (error) { asset = null; }
      if (token !== generation) return null;
      var image = {
        id: app.utils.id("shot"),
        createdAt: Date.now(),
        prompt: prompt,
        model: model.name,
        src: result.src,
        asset: asset,
        logicalFileId: result.logicalFileId || ""
      };
      await app.services.store.addResult(image);
      succeeded = true;
      app.events.emit("generation:done", { image: image });
      return image;
    } catch (error) {
      if (token === generation) app.events.emit("generation:error", { error: error });
      throw error;
    } finally {
      if (token === generation) {
        running = false;
        app.state.busy = false;
        if (!dismissed) app.events.emit("generation:idle", { ok: succeeded });
      }
    }
  }

  var api = {
    init: init,
    run: run,
    cancel: cancel,
    progress: progress,
    configured: configured,
    busy: function () { return running; }
  };
  app.services.imageEngine = api;
})(window.posegi);
