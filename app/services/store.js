/* 持久化:配置与作品
 *
 * 责任:把 app.defaults 的形状与宿主数据区对上,提供读写的唯一入口。
 * 约束:只存引用与标量,图片字节与 Base64 一律不进 haminn.data(见 AGENTS.md)。
 *
 * 数据区布局(collection/key):
 *   config / "app"      → 一份 app.defaults 形状的配置(含模型卡列表)
 *   works  / "list"     → 作品索引 [{ id, title, createdAt, updatedAt, hasResults }]
 *   work   / <workId>   → 一件作品:{ id, title, prompt, negativePrompt, results: [...] }
 *
 * **历史成图(最多 12 张)是作品的一部分** —— 它写在作品记录里,不是一张全局表。
 * 于是"成图跟随作品保存"是数据形状本身保证的:删作品 = 连它的成图一起删,
 * 换作品 = 换一组成图。不必依赖某个保存时机去补救。
 *
 * 为什么不再分块:记录里只有 logicalFileId(图片本体在宿主文件区),
 * 一件作品连 12 张成图也就几 KB,离宿主单条消息上限还差两个数量级。
 */
(function (app) {
  "use strict";

  var CONFIG = { collection: "config", key: "app" };
  var WORKS = { collection: "works", key: "list" };
  var WORK = "work";

  var index = [];
  var saveTimer = 0;
  var queue = Promise.resolve();

  function serial(task) {
    var next = queue.then(task);
    queue = next.catch(function () {});
    return next;
  }

  /* 逐字段合并,保证旧版本存下来的配置缺字段时也能跑 */
  function shapeConfig(raw) {
    var defaults = app.defaults;
    var source = raw && typeof raw === "object" ? raw : {};
    var storedSchema = Number(source.schema) || 0;
    var result = app.utils.merge(defaults, {});
    result.schema = defaults.schema;
    result.preferences = app.utils.merge(defaults.preferences, source.preferences || {});
    result.connection = app.utils.merge(defaults.connection, source.connection || {});
    result.translate = shapeTranslate(source.translate);
    result.newWork = app.utils.merge(defaults.newWork, source.newWork || {});
    result.render = app.utils.merge(defaults.render, source.render || {});
    result.generation = app.utils.merge(defaults.generation, source.generation || {});
    result.reference = app.utils.merge(defaults.reference, source.reference || {});
    result.limits = app.utils.merge(defaults.limits, source.limits || {});
    /* 模型卡:旧版本存下来的是"生图接口"(单一 generation 配置),没有 models 数组 ——
       那种情况下直接用出厂的几张 CVP 卡,不当成脏数据丢掉。 */
    var models = source.models;
    if (Object.prototype.toString.call(models) !== "[object Array]" || !models.length) {
      result.models = app.utils.copy(defaults.models);
      result.activeModelId = defaults.activeModelId;
    } else {
      result.models = models.map(function (item) { return shapeModel(item); });
      result.activeModelId = String(source.activeModelId || result.models[0].id);
    }
    /* schema 2 → 3:补回缺的出厂卡。
       存下来的卡表是权威的(用户改过的名字、加过的卡都在里面),所以新加的出厂卡
       不会自己冒出来 —— 不补的话,老装机升级到这一版也看不到 Qwen 卡。
       只补出厂 id,而且只补一次(下次保存时 schema 已经是 3)。
       **条件写死 3 而不是 `defaults.schema`**:这次补卡是"schema 3 那一次"的迁移,
       写成 defaults.schema 的话,以后每次升 schema 都会把用户删掉的出厂卡再塞回来。 */
    if (storedSchema < 3) {
      defaults.models.forEach(function (factory) {
        var known = result.models.filter(function (item) { return item.id === factory.id; }).length > 0;
        if (!known) result.models.push(app.utils.copy(factory));
      });
    }
    if (!result.models.filter(function (item) { return item.id === result.activeModelId; }).length) {
      result.activeModelId = result.models[0].id;
    }
    return result;
  }

  /* 出厂卡的名字。卡名是给用户看的,所以走 i18n;用户改过名字的卡不会被这里覆盖。 */
  function factoryName(task) {
    if (task === "upscale") return app.i18n.text("渲染出图", "Render");
    if (task === "qwen") return app.i18n.text("Qwen 图像 2.1", "Qwen Image 2.1");
    return app.i18n.text("快速生图", "Quick draw");
  }

  function shapeModel(raw) {
    var item = raw && typeof raw === "object" ? raw : {};
    var limits = app.defaults.limits;
    var protocol = ["cvp", "openai-images", "sd-webui", "stability"].indexOf(item.protocol) >= 0 ? item.protocol : "cvp";
    /* 任务白名单就是 app.defaults.cvpTasks 的键。写成白名单而不是"是不是 upscale",
       是因为第三种任务(Qwen)加进来时,那种写法会把它悄悄降级成 quick ——
       卡上写着 Qwen、发出去的却是快速绘制的路线。 */
    var task = Object.prototype.hasOwnProperty.call(app.defaults.cvpTasks, item.task) ? item.task : "quick";
    var spec = app.defaults.cvpTasks[task];
    return {
      id: String(item.id || app.utils.id("model")),
      name: String(item.name || "").trim() || factoryName(task),
      protocol: protocol,
      task: task,
      endpoint: String(item.endpoint || ""),
      apiKey: String(item.apiKey || ""),
      model: String(item.model || ""),
      customHeaders: String(item.customHeaders || ""),
      size: Math.round(app.utils.clamp(Number(item.size) || (task === "upscale" ? 1024 : 512), limits.size[0], limits.size[1])),
      steps: Math.round(app.utils.clamp(Number(item.steps) || spec.steps, limits.steps[0], limits.steps[1])),
      refStrength: Math.round(app.utils.clamp(Number(item.refStrength) === 0 || !isFinite(Number(item.refStrength)) ? 100 : Number(item.refStrength), limits.refStrength[0], limits.refStrength[1])),
      growMaskBy: Math.round(app.utils.clamp(Number(item.growMaskBy) || 8, 0, 64)),
      quality: String(item.quality || (task === "upscale" ? "high" : "low")),
      /* 只吃英文的模型:生图前先把中文提示词译成英文(见 services/translate.js)。
         必须是 `=== true` 而不是真值判断 —— 旧版本存下来的卡里没有这个字段,
         用真值判断会把 undefined 当成"要翻译",给老用户凭空多出一次网络往返。 */
      needsEnglish: item.needsEnglish === true,
      timeoutMs: Math.round(app.utils.clamp(Number(item.timeoutMs) || spec.timeoutMs, limits.timeoutMs[0], limits.timeoutMs[1]))
    };
  }

  /* 翻译服务:协议有白名单,唯一出处是 app.services.translate.protocols。
     写成白名单而不是"是不是 cvp",是因为以后再加一家时,那种写法会把新协议
     悄悄降级成 CVP 的地址格式 —— 用户填的地址看着没变,请求却发错了地方。
     translate 模块可能还没加载(单测里只装 store),所以取白名单要容错。 */
  function shapeTranslate(raw) {
    var item = raw && typeof raw === "object" ? raw : {};
    var known = (app.services.translate && app.services.translate.protocols) || {};
    var protocol = String(item.protocol || "cvp");
    return {
      enabled: item.enabled === true,
      protocol: Object.prototype.hasOwnProperty.call(known, protocol) ? protocol : "cvp",
      endpoint: String(item.endpoint || ""),
      apiKey: String(item.apiKey || ""),
      model: String(item.model || ""),
      customHeaders: String(item.customHeaders || "")
    };
  }

  /* CVP 的地址/密码/请求头是一套,填在 connection 上;这里把它分发到每张 cvp 卡。
     存进去的卡自己那份保持同步,于是"测试连接"等按钮在保存之前读到的也是真值。 */
  function shareCvp(config) {
    var connection = app.utils.merge({ endpoint: "", apiKey: "", customHeaders: "" }, config.connection || {});
    config.connection = connection;
    (config.models || []).forEach(function (item) {
      if (item.protocol !== "cvp") return;
      item.endpoint = connection.endpoint;
      item.apiKey = connection.apiKey;
      item.customHeaders = connection.customHeaders;
    });
    return config;
  }

  async function loadConfig() {
    var record = await app.platform.haminn.getData(CONFIG.collection, CONFIG.key);
    app.config = shareCvp(shapeConfig(record && record.value));
    app.state.activeModelId = app.config.activeModelId;
    var works = await app.platform.haminn.getData(WORKS.collection, WORKS.key);
    index = works && Object.prototype.toString.call(works.value) === "[object Array]" ? works.value : [];
    return app.config;
  }

  async function saveConfig(config) {
    var value = shareCvp(shapeConfig(config || app.config));
    await serial(function () { return app.platform.haminn.putData(CONFIG.collection, CONFIG.key, value); });
    app.config = value;
    app.state.activeModelId = value.activeModelId;
    return value;
  }

  /* ---------- 作品 ---------- */

  /* 新建作品时的默认角色描述。它是**提示词内容**,所以跟着界面语言走,
     而不是写死一句中文 —— 英文界面上给一句中文提示词,只会逼着用户去装译英服务。 */
  function defaultPrompt() {
    var value = (app.defaults.newWork || {}).prompt || {};
    return String(app.i18n.language() === "en" ? (value.en || value.zh || "") : (value.zh || ""));
  }

  function untitledTitle() {
    var english = app.i18n.language() === "en";
    var pattern = english ? /^Untitled pose\s+(\d+)$/ : /^未命名作品(\d+)$/;
    var highest = 0;
    index.forEach(function (item) {
      var match = pattern.exec(String(item.title || ""));
      if (match) highest = Math.max(highest, Number(match[1]) || 0);
    });
    return (english ? "Untitled pose " : "未命名作品") + (highest + 1);
  }

  function listWorks() {
    return index.map(function (item) {
      return {
        id: item.id,
        title: item.title,
        prompt: item.prompt,
        /* 译文跟着索引一起给出去:作品列表的编辑界面要显示它,
           为了两句英文再回数据区读一次整条作品记录不值得。 */
        promptEn: shapePair(item.promptEn) || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        hasResults: Boolean(item.hasResults),
        count: Number(item.count) || 0,
        current: item.id === app.state.workId
      };
    });
  }

  /* 从记录里读出的译文对:src 与 text 都在才算数 */
  function shapePair(raw) {
    if (!raw || typeof raw !== "object") return null;
    var source = String(raw.source || "").trim(), text = String(raw.text || "").trim();
    return source && text ? { source: source, text: text } : null;
  }

  function storedResult(result) {
    if (!result) return null;
    return {
      id: String(result.id || app.utils.id("shot")),
      createdAt: Number(result.createdAt) || Date.now(),
      prompt: String(result.prompt || ""),
      model: String(result.model || ""),
      asset: result.asset || null,
      logicalFileId: result.logicalFileId || ""
    };
  }

  function snapshot() {
    return {
      schema: 1,
      id: app.state.workId,
      title: app.state.workTitle,
      prompt: app.state.prompt,
      promptEn: promptPair(),
      negativePrompt: app.state.negativePrompt,
      createdAt: 0,
      updatedAt: Date.now(),
      results: (app.state.results || []).map(storedResult).filter(function (item) { return Boolean(item); })
    };
  }

  /* 译文只在"它对应的原文就是当前这段描述"时才跟着作品走。
     用户改了描述,旧译文立刻作废 —— 否则编辑界面会显示一句与当前描述无关的英文。 */
  function promptPair() {
    var pair = app.state.promptEn;
    if (!pair) return null;
    var source = String(pair.source || "").trim();
    if (!source || source !== String(app.state.prompt || "").trim()) return null;
    var text = String(pair.text || "").trim();
    return text ? { source: source, text: text } : null;
  }

  function meaningful() {
    return Boolean(app.state.workId || String(app.state.prompt || "").trim() ||
      String(app.state.negativePrompt || "").trim() || (app.state.results || []).length);
  }

  async function saveNow() {
    if (!meaningful()) return null;
    if (!app.state.workId) app.state.workId = app.utils.id("work");
    if (!String(app.state.workTitle || "").trim()) app.state.workTitle = untitledTitle();
    var record = snapshot();
    var existing = index.filter(function (item) { return item.id === record.id; })[0];
    record.createdAt = existing ? existing.createdAt : Date.now();
    await app.platform.haminn.putData(WORK, record.id, record);
    index = index.filter(function (item) { return item.id !== record.id; });
    index.unshift({
      id: record.id, title: record.title, prompt: record.prompt, promptEn: record.promptEn,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      hasResults: record.results.length > 0, count: record.results.length
    });
    await app.platform.haminn.putData(WORKS.collection, WORKS.key, index);
    app.events.emit("works:changed", index.length);
    return record;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      flush().catch(function (error) { app.events.emit("error", error); });
    }, 700);
  }

  function flush() {
    clearTimeout(saveTimer);
    return serial(saveNow);
  }

  async function queryWork(id) {
    var record = await app.platform.haminn.getData(WORK, String(id || ""));
    return record && record.value ? record.value : null;
  }

  /* 把作品装进运行时状态:成图的 src 先解出来,界面不必自己判空 */  async function hydrate(record) {
    if (!record) return null;
    var value = {
      id: String(record.id || ""),
      title: String(record.title || ""),
      prompt: String(record.prompt || ""),
      promptEn: shapePair(record.promptEn),
      negativePrompt: String(record.negativePrompt || ""),
      results: []
    };
    var list = Object.prototype.toString.call(record.results) === "[object Array]" ? record.results : [];
    for (var position = 0; position < list.length; position += 1) {
      var item = list[position];
      var src = "";
      try { src = await app.services.assets.resolve(item.asset || (item.logicalFileId ? { parts: [item.logicalFileId], mime: "image/png" } : null)); }
      catch (error) { src = ""; }
      value.results.push({
        id: String(item.id || app.utils.id("shot")),
        createdAt: Number(item.createdAt) || 0,
        prompt: String(item.prompt || ""),
        model: String(item.model || ""),
        src: src,
        asset: item.asset || null,
        logicalFileId: item.logicalFileId || ""
      });
    }
    return value;
  }

  function applyToState(work) {
    app.state.workId = work ? work.id : "";
    app.state.workTitle = work ? work.title : "";
    app.state.prompt = work ? work.prompt : "";
    app.state.promptEn = work ? shapePair(work.promptEn) : null;
    app.state.negativePrompt = work ? work.negativePrompt : "";
    app.state.results = work ? work.results : [];
    rememberWork(app.state.workId);
    app.events.emit("work:changed", { id: app.state.workId, title: app.state.workTitle });
  }

  /* ---------- "上次打开的作品" ----------
   *
   * 用户要求「软件启动打开最近一次使用的作品」。存在**配置里**而不是作品记录里:
   * 它描述的是"这台设备上次在看什么",不是作品自身的属性 ——
   * 写进作品记录会让"换个设备打开"读到别人的浏览位置。
   * 写入时机只有一个:applyToState(换作品、开新作品、删掉当前作品都在这里收口)。
   * 配置保存是防抖的:启动时恢复作品也会写一次,不必为此立刻落盘。 */
  var configTimer = 0;

  function saveConfigSoon() {
    clearTimeout(configTimer);
    configTimer = setTimeout(function () {
      saveConfig(app.config).catch(function (error) { app.events.emit("error", error); });
    }, 600);
  }

  function rememberWork(id) {
    if (!app.config) return;
    var value = String(id || "");
    if (String(app.config.preferences.lastWorkId || "") === value) return;
    app.config.preferences.lastWorkId = value;
    saveConfigSoon();
  }

  function lastWorkId() { return app.config ? String(app.config.preferences.lastWorkId || "") : ""; }

  function hasWorks() { return index.length > 0; }

  /* 改一件作品的标题 / 角色描述。改的是"当前作品"就地生效并落盘;
     改别人就先读出来改完写回,并同步索引里的那两行(列表要显示标题与描述)。
     为什么不让界面自己去拼记录:索引与作品记录是两份数据,漏更新一份就是
     "列表里还是旧标题"。 */
  async function updateWork(id, values) {
    var target = String(id || app.state.workId || "");
    if (!target) return null;
    /* 传了就用传的(空串也算"用户清空了它"),没传就保持原样 ——
       别用 `values.prompt === undefined ? "" : …` 这种写法,
       运算优先级会把它变成 `(values && 判断) ? "" : values.prompt`,传空串时反而写不进去。 */
    var hasPrompt = Boolean(values) && values.prompt !== undefined && values.prompt !== null;
    var title = String((values && values.title) || "").trim();
    if (target === app.state.workId) {
      app.state.workTitle = title || app.state.workTitle || untitledTitle();
      if (hasPrompt) {
        app.state.prompt = String(values.prompt);
        /* 描述一改,旧译文就作废;缓存里正好有这句的新译文就顺手挂上 */
        app.state.promptEn = app.services.translate.pair(app.state.prompt, "");
      }
      await flush();
      applyToState({
        id: app.state.workId, title: app.state.workTitle, prompt: app.state.prompt,
        promptEn: app.state.promptEn,
        negativePrompt: app.state.negativePrompt, results: app.state.results
      });
      return app.state.workId;
    }
    var record = await queryWork(target);
    if (!record) throw new Error(app.i18n.text("找不到这件作品", "Artwork not found"));
    record.title = title || String(record.title || "").trim() || untitledTitle();
    if (hasPrompt) {
      record.prompt = String(values.prompt);
      record.promptEn = app.services.translate.pair(record.prompt, "") || null;
    }
    record.updatedAt = Date.now();
    await app.platform.haminn.putData(WORK, record.id, record);
    index = index.map(function (item) {
      if (item.id !== record.id) return item;
      return app.utils.merge(item, { title: record.title, prompt: record.prompt, promptEn: record.promptEn, updatedAt: record.updatedAt });
    });
    await app.platform.haminn.putData(WORKS.collection, WORKS.key, index);
    app.events.emit("works:changed", index.length);
    return record.id;
  }

  async function openWork(id) {
    await flush();
    var record = await queryWork(id);
    if (!record) throw new Error(app.i18n.text("找不到这件作品", "Artwork not found"));
    applyToState(await hydrate(record));
    return app.state;
  }

  /* 新作品:先把当前这件存好,再开一份空的。
     标题留空就当场取「未命名作品 N」—— 不拖到第一次保存时才取名,
     因为"添加作品"之后它就该出现在作品列表里,哪怕还一个字都没写。
     角色描述不传就取默认值(一个科幻女战士);显式传空串表示用户清空了它,照样允许。 */
  async function newWork(title, prompt) {
    await flush();
    var value = prompt === undefined || prompt === null ? defaultPrompt() : String(prompt);
    applyToState({
      id: app.utils.id("work"),
      title: String(title || "").trim() || untitledTitle(),
      prompt: value,
      /* 默认描述是句中文,译英缓存里可能已经有它了(比如上一件作品刚翻过) */
      promptEn: app.services.translate.pair(value, ""),
      negativePrompt: app.state.negativePrompt,
      results: []
    });
    await flush();
    app.events.emit("works:changed", index.length);
    return app.state;
  }

  async function removeWork(id) {
    await flush();
    var record = await queryWork(id);
    var nextIndex = index.filter(function (item) { return item.id !== id; });
    index = nextIndex;
    await app.platform.haminn.deleteData(WORK, String(id));
    await app.platform.haminn.putData(WORKS.collection, WORKS.key, index);
    if (app.state.workId === id) applyToState(null);
    if (record) {
      var remaining = [];
      for (var position = 0; position < index.length; position += 1) {
        var saved = await queryWork(index[position].id);
        if (saved) remaining.push(saved);
      }
      remaining.push(snapshot());
      await app.services.assets.cleanup(record, remaining).catch(function () {});
    }
    app.events.emit("works:changed", index.length);
  }

  /* 新成图入列。超过上限就丢最旧的,并把它独占的文件删掉 ——
     上限是"作品里留几张",不是"永远不许有第 13 张"。 */
  async function addResult(image) {
    var stored = storedResult(image);
    app.state.results.push({
      id: stored.id, createdAt: stored.createdAt, prompt: stored.prompt, model: stored.model,
      src: image.src, asset: stored.asset, logicalFileId: stored.logicalFileId
    });
    var max = Number(app.config && app.config.maxResults) || 12;
    var dropped = [];
    while (app.state.results.length > max) dropped.push(app.state.results.shift());
    await flush();
    if (!dropped.length) return stored;
    var remaining = [snapshot()];
    for (var position = 0; position < index.length; position += 1) {
      if (index[position].id === app.state.workId) continue;
      var saved = await queryWork(index[position].id);
      if (saved) remaining.push(saved);
    }
    await app.services.assets.cleanup({ results: dropped }, remaining).catch(function () {});
    return stored;
  }

  async function removeResult(resultId) {
    var target = (app.state.results || []).filter(function (item) { return item.id === resultId; })[0];
    if (!target) return false;
    app.state.results = app.state.results.filter(function (item) { return item.id !== resultId; });
    await flush();
    var remaining = [snapshot()];
    await app.services.assets.cleanup({ results: [target] }, remaining).catch(function () {});
    return true;
  }

  app.services.store = {
    shapeConfig: shapeConfig,
    shareCvp: shareCvp,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    listWorks: listWorks,
    openWork: openWork,
    newWork: newWork,
    updateWork: updateWork,
    removeWork: removeWork,
    addResult: addResult,
    removeResult: removeResult,
    untitledTitle: untitledTitle,
    defaultPrompt: defaultPrompt,
    lastWorkId: lastWorkId,
    hasWorks: hasWorks,
    rememberWork: rememberWork,
    saveConfigSoon: saveConfigSoon,
    snapshot: snapshot,
    scheduleSave: scheduleSave,
    flush: flush
  };
})(window.posegi);
