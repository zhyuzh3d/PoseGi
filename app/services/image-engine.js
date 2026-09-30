/* 生图编排:截图 → 组装请求 → 调用 → 落地结果
 *
 * 责任:串起 viewport 的截图、providers 的协议翻译、platform 的请求与 store 的落地。
 * 事件契约(其它模块只依赖这些事件,不直接调用内部函数):
 *   generation:start    { model }
 *   generation:progress { stage, detail }
 *   generation:done     { image }
 *   generation:error    { error }
 *   generation:blocked  { model, reason }  自检没过,**没有开始生成**
 *   generation:idle     无论成功、失败、被拦下还是被取消,等待都结束了
 *
 * 生成前自检(2026-09-30 用户要求):点一次生成先问 providers.preflight
 * ——"这张卡现在能不能发出去"。不过的时候**不抛**,而是发 generation:blocked:
 * 抛出去只会变成一条转瞬即逝的提示,而用户要的是一个弹窗 + 一个把他送到
 * 模型设置的按钮(那句话由界面层说,本模块不认识弹窗)。
 *
 * 依赖注入:init({ capture }) —— capture() 返回 { dataUrl, mime, width, height },
 * 由 app/app.js 把 viewport.captureAt 包一层传进来,避免本模块直接依赖渲染层。
 *
 * 两个关键口径:
 *   1) **参考图永远是 9:16、高度 1024**(app.config.reference)。姿态渲染图是给模型的
 *      "内容依据",它不该随模型卡分辨率变化 —— 换了张 768x1344 的卡,模型看到的
 *      仍该是同一张图。而比例必须与任务画幅一致:插件会用 `stretched_reference`
 *      当场拒掉比例对不上的参考图(真机实测过)。
 *   2) **取消 = 忽略这次等待**(用户原话:「点击就忽略刚才发起的生成」)。
 *      服务端的任务我们停不掉(插件不保证可中断),所以只保证"结果不再落到作品里"。
 *
 * 提示词前缀(2026-09-30 用户要求):每次提交生成时在提示词**开头**补一句,
 * 说明参考图 1 只当姿势用。见 POSE_PREFIX。
 *
 * 提交哪一份提示词(2026-09-30 用户要求):卡要英文时,提交前自动译英并缓存复用
 * (界面上没有翻译按钮,翻不翻全在这里定);卡不要英文时一律用输入框那份。
 * 见 prepare。
 */
(function (app) {
  "use strict";

  var capture = null;
  var running = false;
  var generation = 0;
  var dismissed = false;
  var listeningPending = false;

  /* 参考图是"姿势依据",不是"人物长相的依据"(2026-09-30 用户要求)。
   *
   * 不说这一句的话,模型会把参考图里那个人偶的外观一起搬过来 —— 体型、发型、衣服
   * 都跟着走,而用户要的只是它摆出来的那个姿势(PoseGi 的人偶本来就是通用替身)。
   * 所以每次提交都在**提示词开头**明说一次,不写进作品提示词里:
   * 它是发给模型的一行调用参数,不是用户写的内容,存进作品会让列表里每件作品都长得一样。
   *
   * 语言跟着**最终提示词**走,而不是跟着界面语言:模型卡要英文时整段提示词已经
   * 译成英文(见 prepare),那时候再往英文提示词前面挂一句中文,两句话互相打架。
   * 空提示词(允许为空)没有语言线索,才按界面语言。 */
  var POSE_PREFIX = {
    zh: "参考图1只做姿势参考，不要使用参考图中角色的人物外形、发型或服饰等任何外观特征。",
    en: "Reference image 1 is for pose reference only. Do not use any appearance features of the character in the reference image, such as their body shape, hairstyle, or clothing."
  };

  /* 该补哪一种语言的那一句 */
  function posePrefix(prompt) {
    var text = String(prompt === null || prompt === undefined ? "" : prompt).trim();
    if (text) return app.services.translate.hasCjk(text) ? POSE_PREFIX.zh : POSE_PREFIX.en;
    return app.i18n.language() === "en" ? POSE_PREFIX.en : POSE_PREFIX.zh;
  }

  /* 提示词为空时前缀就是整段提示词(不能留下一个空行开头) */
  function withPosePrefix(prompt) {
    var text = String(prompt === null || prompt === undefined ? "" : prompt).trim();
    var head = posePrefix(text);
    return text ? head + "\n" + text : head;
  }

  function t(zh, en) { return app.i18n.text(zh, en); }

  function init(options) {
    capture = options && typeof options.capture === "function" ? options.capture : null;
    /* 提交成功后 providers 把那个作业交上来(它不认识 store,只发事件):
       记进运行时状态并**立刻落盘** —— 这个 job id 是"服务端那张图还能取回来"的
       唯一凭据,而它可能在下一秒就被杀掉进程。清除走的是同一条事件(pending: null),
       所以"取回成功 / 作业失败 / 被取消"四种结局只有一处出口。 */
    if (!listeningPending) {
      listeningPending = true;
      app.events.on("generation:pending", function (detail) {
        var pending = detail && detail.pending;
        app.state.pendingJob = pending && pending.jobId ? pending : null;
        app.services.store.scheduleSave();
      });
    }
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
    /* 用户的取消口径是「忽略刚才发起的生成」(见文件头),所以那个作业也不再挂着:
       留着一个 id 会让界面一直摆一个「重试取回」,而用户刚刚说的正是不想要它。
       服务端那边我们停不掉它,这里只保证它的结果不再落到作品里。 */
    if (app.state.pendingJob) {
      app.state.pendingJob = null;
      app.services.store.scheduleSave();
    }
    app.state.busy = false;
    app.events.emit("generation:idle", { cancelled: true });
  }

  /* 提交时到底发哪一份提示词(2026-09-30 用户定):
       「如果模型需要翻译为英文,那么,如果配置了翻译模型,每次提交的时候 PoseGi 就自动
        使用这个翻译模型进行翻译,然后缓存备用避免下次同样内容重复调用模型翻译,
        把翻译结果直接发给生图模型使用;如果没有配置翻译模型,就在提示词输入框添加
        （请使用英文,或软件设置中增加翻译模型）。」
     于是界面上不再有任何翻译按钮与输入框(见 components/translate-hint.js),
     翻不翻、翻什么全在这里定。三步,顺序有意义:
       一、现成的先用 —— 作品里存的那对译文(原文对得上才算数)或进程内的译英缓存。
           同一句话第二次不再问模型,这正是"缓存备用"那半句。
       二、中文才值得翻。本来就是英文的提示词原样发出去。
       三、真去翻一次(translate.translate 只翻没翻过的,自己带缓存)。
     **翻不出来绝不拦生成**,退回原文:报错拦下就变成"按钮点了没反应",那是更坏的结果,
     而且 CHP 插件端本来也会译英(它的 translation.mode 是 auto-on-submit)。
     空提示词是允许的(用户要求「提示词可以为空」):这时按参考图直接出图。 */
  /* 记进作品的那一句 = **实际发出去**的那一句(卡要英文时发的是译文,见 prepare)。
     续取那条路上没有本地那份 prompt 变量可用,所以要能独立算出来 —— 否则同一件
     作品里会一条中文、一条英文。 */
  function keptPrompt() {
    var source = String(app.state.prompt || "").trim();
    var ready = app.services.translate.fromPair({ promptEn: app.state.promptEn }, source);
    return ready && ready !== source ? ready : source;
  }

  async function prepare(model, prompt) {
    if (!prompt || !app.services.translate.needed(model)) return prompt;

    var ready = app.services.translate.fromPair({ promptEn: app.state.promptEn }, prompt);
    if (ready && ready !== prompt) {
      progress("translate", t("这张卡要英文提示词,这次用已经存好的英文版本",
        "This card wants English, so the saved English version is what gets sent"));
      return ready;
    }
    if (!app.services.translate.hasCjk(prompt)) return prompt;
    if (!app.services.translate.ready()) {
      progress("translate", t("这张卡需要英文提示词,但译英模型还没配置好,这次直接按原文生成",
        "This card wants an English prompt, but no translation model is set up; sending the text as-is."));
      return prompt;
    }

    progress("translate", t("正在把角色描述译成英文…", "Translating the description into English…"));
    await app.services.translate.translate([prompt]);
    var english = app.services.translate.english(prompt);
    if (!english || english === prompt) return prompt;
    /* 译文存进作品:它跟着这件作品走,换个进程、换件作品再回来都还在
       (列表面板不再显示它,但成图记录里那句"实际发出去的是什么"依赖它)。 */
    app.state.promptEn = app.services.translate.pair(prompt, english);
    app.services.store.scheduleSave();
    return english;
  }

  /* 把一张取回来的结果落进作品。run 与 resume 走**同一条路** —— 成图记录的形状
     只在这里定义一次,否则两条路早晚会长出不一样的作品。
     拆成两步是为了留住"取消"那道闸:写文件是慢的那一步,取消要能在它之后、
     落进列表之前生效(见 run 里那两个 token 检查)。 */
  async function persistShot(result) {
    try { return await app.services.assets.persist(result.src, null); } catch (error) { return null; }
  }

  async function recordShot(asset, result, model, prompt) {
    var image = {
      id: app.utils.id("shot"),
      createdAt: Date.now(),
      prompt: prompt,
      model: model ? model.name : "",
      src: result.src,
      asset: asset,
      logicalFileId: result.logicalFileId || ""
    };
    await app.services.store.addResult(image);
    return image;
  }

  /* 续取:按作品里记着的那个 job id 再取一次(见 providers.resume)。
   *
   * 关键区别 —— 它**不重新提交**。服务端那张图可能已经画好了,重画一张既慢又白费。
   * 事件照走 run 的那一套(start / progress / done / error / idle),所以界面不需要
   * 为它写第二套渲染。
   *
   * `busy()` 也照旧:续取期间不该再点生成。 */
  async function resume() {
    if (running) {
      progress("queued", t("上一次生成还没结束,请稍候", "The previous generation is still running"));
      return null;
    }
    var model = app.services.providers.active();
    var pending = app.state.pendingJob;
    if (!pending || !pending.jobId) {
      throw new Error(t("没有等待取回的任务", "There is no job waiting to be retrieved"));
    }

    running = true;
    dismissed = false;
    var token = ++generation;
    var succeeded = false;
    app.state.busy = true;
    app.events.emit("generation:start", {
      model: model ? { id: model.id, name: model.name, protocol: model.protocol } : null
    });
    try {
      progress("retrieve", t("正在向服务器取回上一次的成图…", "Fetching the previous image from the server…"));
      var found = await app.services.providers.resume(model, pending);
      if (token !== generation) return null;
      /* 服务端还在跑 —— **这不是失败**。记着的 id 照旧留着,用户过一会儿再点一次即可,
         界面也照旧显示这段话(它比"出错"准确得多:什么事都没出错)。 */
      if (found.running) {
        progress("running", t("服务端的任务还在进行中,请稍后再点一次「重试取回」",
          "The job is still running on the server; tap Retrieve again in a moment."));
        return null;
      }
      progress("store", t("正在保存成图…", "Saving the image…"));
      var asset = await persistShot(found.result);
      if (token !== generation) return null;
      var image = await recordShot(asset, found.result, model, keptPrompt());
      /* 图到手了,记录就此作废。**在这一层清,不等 providers 发事件** ——
         记着它的是这一层(见 init 里那个订阅),收尾也该由这一层负责。 */
      app.state.pendingJob = null;
      app.services.store.scheduleSave();
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

  async function run() {
    if (running) {
      progress("queued", t("上一次生成还没结束,请稍候", "The previous generation is still running"));
      return null;
    }
    var model = app.services.providers.active();
    /* 接线错(没接截图口)是代码问题,照旧抛 —— 它不是用户能改的东西 */
    if (!capture) throw new Error(t("生图编排尚未接入 3D 视口", "The generation pipeline is not wired to the 3D viewport"));

    var prompt = String(app.state.prompt || "").trim();
    var negativePrompt = String(app.state.negativePrompt || "").trim();

    /* 忙状态**在自检之前**就置上:自检本身要联网(最多 PROBE_TIMEOUT_MS 秒),
       这段时间里那颗图标该已经在呼吸、进度该已经在转 —— 否则用户以为那一按没生效。 */
    running = true;
    dismissed = false;
    var token = ++generation;
    var succeeded = false;
    app.state.busy = true;
    app.events.emit("generation:start", {
      model: model ? { id: model.id, name: model.name, protocol: model.protocol } : null
    });
    try {
      progress("preflight", t("正在检查模型是否可用…", "Checking that the model is usable…"));
      var ready = await app.services.providers.preflight(model);
      if (token !== generation) return null;
      if (!ready.ok) {
        app.events.emit("generation:blocked", { model: model ? model.id : "", reason: ready.reason });
        return null;
      }
      /* 这一次到底发的是哪一份提示词,在这里定死(见 prepare 的注释) */
      prompt = await prepare(model, prompt);
      var reference = app.config.reference || app.defaults.reference;
      progress("capture", t("正在渲染 " + app.defaults.ratio + " 的 " + reference.height + " 高参考图…",
        "Rendering a " + app.defaults.ratio + " reference at " + reference.height + " high…"));
      var shot = await capture();
      if (token !== generation) return null;
      var input = {
        /* 发出去的是"前缀 + 提示词";记在作品里的仍是提示词本身(前缀是固定的一行
           调用参数,不是用户写的内容 —— 存进去会让成图记录里每一条都带着同一句废话) */
        prompt: withPosePrefix(prompt),
        negativePrompt: negativePrompt,
        seed: -1,
        imageDataUrl: shot.dataUrl,
        mime: shot.mime
      };
      var result = await withDeadline(app.services.providers.generate(model, input), overallTimeout(model));
      if (token !== generation) return null;
      progress("store", t("正在保存成图…", "Saving the image…"));
      var asset = await persistShot(result);
      if (token !== generation) return null;
      var image = await recordShot(asset, result, model, prompt);
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
    /* 续取上一次提交、但没取回来的那张图(见 app.state.pendingJob) */
    resume: resume,
    cancel: cancel,
    progress: progress,
    configured: configured,
    posePrefix: posePrefix,
    withPosePrefix: withPosePrefix,
    /* 有没有一个待取回的作业 —— 界面据此决定要不要摆那个入口 */
    pending: function () { return app.state.pendingJob || null; },
    busy: function () { return running; }
  };
  app.services.imageEngine = api;
})(window.posegi);
