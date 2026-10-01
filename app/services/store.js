/* 持久化:配置与作品
 *
 * 责任:把 app.defaults 的形状与宿主数据区对上,提供读写的唯一入口。
 * 约束:只存引用与标量,图片字节与 Base64 一律不进 haminn.data(见 AGENTS.md)。
 *
 * 数据区布局(collection/key):
 *   config / "app"      → 一份 app.defaults 形状的配置(含模型卡列表)
 *   works  / "list"     → 作品索引 [{ id, title, createdAt, updatedAt, hasResults }]
 *   work   / <workId>   → 一件作品:{ id, title, prompt, negativePrompt, results: [...],
 *                                    pose, view, modelId, figure, render }
 *
 * **历史成图(最多 12 张)是作品的一部分** —— 它写在作品记录里,不是一张全局表。
 * 于是"成图跟随作品保存"是数据形状本身保证的:删作品 = 连它的成图一起删,
 * 换作品 = 换一组成图。不必依赖某个保存时机去补救。
 *
 * 为什么不再分块:记录里只有 logicalFileId(图片本体在宿主文件区),
 * 一件作品连 12 张成图也就几 KB,离宿主单条消息上限还差两个数量级。
 *
 * ---------- 作品文档 schema ----------
 *
 *   schema 1  标题 + 提示词 + 成图。
 *   schema 2  **再加这一件作品长什么样**(2026-09-30 用户要求):
 *             pose    姿态。app.rig.serialize 那一份(关节角度表 + 预设名),
 *                     形状与「姿态库」时期完全相同,因为读写用的还是 rig 那一对函数。
 *             view    视口。{ azimuth, elevation, distance, targetY },
 *                     与 viewport.view() / viewport.applyView() 一一对应。
 *             modelId 生图用哪张模型卡。打开作品时它不在了要弹窗提示重选(见 app.js)。
 *             figure  人偶造型 id。
 *   schema 3  再加 render:**成图的调色**(2026-09-30 用户要求「调色参数也要保存到作品文档」)。
 *             六个滑杆 + 一个「调色效果」开关,形状与行程见 services/render-adjust.js。
 *             没有调色时存 null —— 不是一份全中性的对象(那种值不表达任何东西)。
 *   schema 4  再加 pending:**一个交出去、还没把图取回来的作业**(2026-09-30 真机事故后加)。
 *             `{ jobId, task, requestId, createdAt }`,由 services/providers.js 在提交成功
 *             那一刻发 `generation:pending` 事件交上来(它不认识 store),取回成功 / 作业失败 /
 *             被取消 / 服务端已清掉时置空。
 *
 *             为什么要**落盘**:作业一旦交给服务端,那张图就只有 job id 能找回来。进程被杀、
 *             手机重启都发生过,记录只在内存里就等于没记;跟着作品走,才真的"还能取回来"。
 *             旧作品读出来是 null(正常:没有待取回的作业),所以这次迁移只标记版本、不补结构。
 *
 *             前五样**都由别的模块持有**(poser / viewport / figure / providers / 全屏看图),
 *             所以两个方向都不在这里发生:存的时候走 attachDocument 登记的取数函数,
 *             装的时候由 applyToState 发 work:loaded 事件。store 只负责形状收口。
 *             schema 1 的旧作品这五样一律为空 ⇒ 打开时回出厂姿势与出厂视口 ——
 *             这正是用户要的"新建 / 打开一件没存过姿势的作品时恢复初始状态"。
 */
(function (app) {
  "use strict";

  var CONFIG = { collection: "config", key: "app" };
  var WORKS = { collection: "works", key: "list" };
  var WORK = "work";

  var index = [];
  var saveTimer = 0;
  var queue = Promise.resolve();

  /* 作品文档里那四样"由别的模块持有"的东西(姿态 / 视口 / 模型卡 / 造型)的取数口。
     由装配层(app.js)在启动时交进来 —— store 不认识 poser 与 viewport(那是 features
     与 components 层),反向依赖它们会把分层倒过来,而且单测里只装 store 时那两个模块
     根本不存在。没登记时文档部分一律为空,存出来的就是一件 schema 2、四样皆空的作品。 */
  var documentSource = null;

  function attachDocument(source) {
    documentSource = typeof source === "function" ? source : null;
  }

  function documentNow() {
    if (!documentSource) return {};
    try {
      var value = documentSource();
      return value && typeof value === "object" ? value : {};
    } catch (error) {
      /* 取不到姿态/视口不该让整次保存失败("改了标题存不进去"比"姿态没存上"更坏) */
      return {};
    }
  }

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
       那种情况下直接用出厂的几张 CHP 卡,不当成脏数据丢掉。 */
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
    /* schema 4 → 5:出厂卡的名字跟着场景改名走。
       `render` 那张卡的新名字是"高质量生图"(插件给这个场景定的名字也是它);旧名
       "Qwen 图像 2.1"点的是**模型族**而不是这个场景 —— 插件换了模型,那个名字就
       对不上了。只改**还叫旧出厂名**的那些:用户自己改过名字的卡一个字都不动。 */
    if (storedSchema > 0 && storedSchema < 5) {
      var STALE_NAMES = { render: ["Qwen 图像 2.1", "Qwen Image 2.1"] };
      result.models.forEach(function (item) {
        if ((STALE_NAMES[item.task] || []).indexOf(item.name) >= 0) item.name = factoryName(item.task);
      });
    }
    /* schema 5 → 6:画幅锁 9:16(见 app.defaults.ratio)。插件当前只为 render 公布了
       9:16 档,所以出厂激活卡从"快速生图"换成"高质量生图";老装机上还**停在出厂那两张
       没有 9:16 档的卡**上时一并挪过去 —— 那两张卡锁 9:16 之后根本发不出请求,
       继续当激活卡只会让人一按生图就报错,而他自己并不知道该换哪张。
       只认这两个出厂 id:用户自己加过卡、或停在别的卡上,一个都不动。 */
    if (storedSchema > 0 && storedSchema < 6) {
      var NO_PORTRAIT = ["chp-quick", "chp-render"];
      if (NO_PORTRAIT.indexOf(result.activeModelId) >= 0) {
        var portrait = result.models.filter(function (item) { return item.id === "chp-qwen"; })[0];
        if (portrait) result.activeModelId = portrait.id;
      }
    }
    if (!result.models.filter(function (item) { return item.id === result.activeModelId; }).length) {
      result.activeModelId = result.models[0].id;
    }
    return result;
  }

  /* 出厂卡的名字。卡名是给用户看的,所以走 i18n;用户改过名字的卡不会被这里覆盖。 */
  function factoryName(task) {
    if (task === "upscale") return app.i18n.text("图像放大", "Upscale");
    if (task === "render") return app.i18n.text("高质量生图", "High-quality render");
    return app.i18n.text("快速生图", "Quick draw");
  }

  /* 卡的旧场景名 → 插件的场景名。
   *
   * `chp/2` 取消了别名机制,所以 `quick` 与 `qwen` 不再"另一个叫法",而是**错的**:
   * 发过去会换来 `unsupported_category`。老装机上存着的卡必须在这里收口,否则用户
   * 升级本应用之后每一张老卡都出不了图。
   * 映射表放这里而不是留在 providers 里当"两套词的换算":那样子看起来像兼容层,
   * 而它其实是一次**单向迁移** —— 进得来的是旧值,出去的只有新值。 */
  var LEGACY_TASK = { quick: "fast", qwen: "render" };

  /* 分辨率:形式是 `"WxH"`,宽高比锁死 9:16(见 app.defaults.ratio / resolutions)。
   *
   * 老装机上存的是**正方边长**(字段还叫 `size`,一个数字),比例锁死之后那个概念不成立
   * 了 —— 这里做一次单向迁移:旧的边长当**宽度**用,在 9:16 那份清单里挑宽度最接近的
   * 一条(512 → 512x912、1024 → 1024x1820)。
   * CHP 卡只有一个例外:它的画幅由插件的帧表决定(见 providers 的 chpResolution),
   * 本应用离线推不出来 —— 所以「存着的是一条 WxH」就留着,否则留空,由插件说了算。 */
  function shapeResolution(item, protocol) {
    var list = app.defaults.resolutions || [];
    var stored = String(item.resolution == null ? "" : item.resolution).trim();
    if (/^\d+x\d+$/.test(stored)) return stored;
    if (protocol === "chp") return "";
    var wanted = Number(item.size);
    if (!(wanted > 0) || !list.length) return String(list[0] || "");
    var best = list[0], gap = Infinity;
    list.forEach(function (value) {
      var width = Number(String(value).split("x")[0]) || 0;
      if (Math.abs(width - wanted) < gap) { gap = Math.abs(width - wanted); best = value; }
    });
    return best;
  }

  function shapeModel(raw) {
    var item = raw && typeof raw === "object" ? raw : {};
    var limits = app.defaults.limits;
    var protocol = ["chp", "openai-images", "sd-webui", "stability"].indexOf(item.protocol) >= 0 ? item.protocol : "chp";
    /* 场景白名单:出厂表里有、或**插件当前播报过**(见 providers 的 chpCategories)。
       出厂表是"还没读过插件文档"时的兜底,不是唯一真理 —— 插件多播报一个场景、
       或用户自己在插件那边加了一条规则,卡上选它就不该被这里悄悄改成 fast:
       那会让卡上写着那个场景、发出去的却是快速绘制的路线。
       真脏的值(空串、别的词)照旧退回 fast,这道收口没有放松。 */
    var wanted = String(item.task || "");
    var task = Object.prototype.hasOwnProperty.call(LEGACY_TASK, wanted) ? LEGACY_TASK[wanted] : wanted;
    var known = app.services.providers && app.services.providers.internals
      ? app.services.providers.internals.chpCategories() : Object.keys(app.defaults.chpTasks);
    if (known.indexOf(task) < 0) task = "fast";
    /* 出厂表里没有这个场景也要活下来:插件多播报一个场景(比如 2026-10-01 加的
       `generate`)之后,上面那道白名单会放它进来,而这张表里没有它的那一行 ——
       直接读 `spec.steps` 会当场抛。兜底取 fast 那一行,与 providers 的 chpSpec
       同一个口径(它也是 `chpTasks[task] || chpTasks.fast`)。 */
    var spec = app.defaults.chpTasks[task] || app.defaults.chpTasks.fast;
    return {
      id: String(item.id || app.utils.id("model")),
      name: String(item.name || "").trim() || factoryName(task),
      protocol: protocol,
      task: task,
      endpoint: String(item.endpoint || ""),
      apiKey: String(item.apiKey || ""),
      model: String(item.model || ""),
      customHeaders: String(item.customHeaders || ""),
      resolution: shapeResolution(item, protocol),
      /* CHP 的步数**不是用户可选项**,插件按自己的枚举判(越界报 unsupported_steps),
        `chp/2` 又不公布那张枚举表 ⇒ 本应用只发自己那份出厂值。老装机上被滑杆调过的
       数字在这里收回来,否则它会一直发一个服务端不认的步数。别的协议照旧自己填。 */
      steps: protocol === "chp" ? spec.steps : Math.round(app.utils.clamp(Number(item.steps) || spec.steps, limits.steps[0], limits.steps[1])),
      refStrength: Math.round(app.utils.clamp(Number(item.refStrength) === 0 || !isFinite(Number(item.refStrength)) ? 100 : Number(item.refStrength), limits.refStrength[0], limits.refStrength[1])),
      quality: String(item.quality || (task === "upscale" ? "high" : "low")),
      /* 只吃英文的模型:生图前先把中文提示词译成英文(见 services/translate.js)。
         必须是 `=== true` 而不是真值判断 —— 旧版本存下来的卡里没有这个字段,
         用真值判断会把 undefined 当成"要翻译",给老用户凭空多出一次网络往返。 */
      needsEnglish: item.needsEnglish === true,
      timeoutMs: Math.round(app.utils.clamp(Number(item.timeoutMs) || spec.timeoutMs, limits.timeoutMs[0], limits.timeoutMs[1]))
    };
  }

  /* 翻译服务:协议有白名单,唯一出处是 app.services.translate.protocols。
     写成白名单而不是"是不是 chp",是因为以后再加一家时,那种写法会把新协议
     悄悄降级成 CHP 的地址格式 —— 用户填的地址看着没变,请求却发错了地方。
     translate 模块可能还没加载(单测里只装 store),所以取白名单要容错。 */
  function shapeTranslate(raw) {
    var item = raw && typeof raw === "object" ? raw : {};
    var known = (app.services.translate && app.services.translate.protocols) || {};
    var protocol = String(item.protocol || "chp");
    return {
      enabled: item.enabled === true,
      protocol: Object.prototype.hasOwnProperty.call(known, protocol) ? protocol : "chp",
      endpoint: String(item.endpoint || ""),
      apiKey: String(item.apiKey || ""),
      model: String(item.model || ""),
      customHeaders: String(item.customHeaders || "")
    };
  }

  /* CHP 的地址/密码/请求头是一套,填在 connection 上;这里把它分发到每张 chp 卡。
     存进去的卡自己那份保持同步,于是"测试连接"等按钮在保存之前读到的也是真值。 */
  function shareChp(config) {
    var connection = app.utils.merge({ endpoint: "", apiKey: "", customHeaders: "" }, config.connection || {});
    config.connection = connection;
    (config.models || []).forEach(function (item) {
      if (item.protocol !== "chp") return;
      item.endpoint = connection.endpoint;
      item.apiKey = connection.apiKey;
      item.customHeaders = connection.customHeaders;
    });
    return config;
  }

  async function loadConfig() {
    var record = await app.platform.haminn.getData(CONFIG.collection, CONFIG.key);
    app.config = shareChp(shapeConfig(record && record.value));
    app.state.activeModelId = app.config.activeModelId;
    var works = await app.platform.haminn.getData(WORKS.collection, WORKS.key);
    index = works && Object.prototype.toString.call(works.value) === "[object Array]" ? works.value : [];
    return app.config;
  }

  async function saveConfig(config) {
    var value = shareChp(shapeConfig(config || app.config));
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

  /* ---------- 作品文档的形状收口 ----------
   *
   * 存进来的可能是任意一份记录(自己上一个版本写的、用户手改过的),所以四个字段都过一遍
   * "只留看得懂的"。**取值范围**不在这里判:姿态的关节上下限归 app.rig(poser.restore
   * 会走 rig.parse → normalize),视口的合法性归 viewport.applyView。这里只保证形状。
   */

  /* 姿态:形状与 app.rig.serialize 写出来的一致(关节名 → {x,y,z})。
     一个关节都没有时返回 null —— 那是"这份作品没存过姿态",不是"存了一个空姿态"。
     每个轴要过 app.utils.finiteNumber:判据在 core/utils 一处(它守的是"记录里这个值
     算不算数",调色参数那边问的是同一句话)。 */
  function shapePose(raw) {
    if (!raw || typeof raw !== "object") return null;
    var source = raw.angles;
    if (!source || typeof source !== "object") return null;
    var angles = {};
    Object.keys(source).forEach(function (name) {
      var item = source[name];
      if (!item || typeof item !== "object") return;
      var axes = {};
      ["x", "y", "z"].forEach(function (key) {
        var value = app.utils.finiteNumber(item[key]);
        if (value !== null) axes[key] = value;
      });
      if (Object.keys(axes).length) angles[name] = axes;
    });
    if (!Object.keys(angles).length) return null;
    return {
      schema: Number(raw.schema) || 1,
      name: String(raw.name || ""),
      updatedAt: Number(raw.updatedAt) || 0,
      angles: angles
    };
  }

  /* 视口:**四个通道齐了才算一份视口**。只存了一半(比如只有 targetY)时宁可整份丢掉 ——
     半份视口装回去会得到"角度是这件作品的、距离是上一件作品的"那种怪视角,比回出厂更糟。 */
  var VIEW_KEYS = ["azimuth", "elevation", "distance", "targetY"];

  function shapeView(raw) {
    if (!raw || typeof raw !== "object") return null;
    var out = {};
    VIEW_KEYS.forEach(function (key) {
      var value = app.utils.finiteNumber(raw[key]);
      if (value !== null) out[key] = value;
    });
    if (Object.keys(out).length !== VIEW_KEYS.length || out.distance <= 0) return null;
    return out;
  }

  /* 调色形状:直接借 services/render-adjust 那一份(参数表、行程、中性判定都在那里)。
     作品文档这一层只决定"存什么" —— 没有调色就存 null,而不是存一份全中性的对象。 */
  function shapeRender(raw) { return app.services.renderAdjust.stored(raw); }

  /* 待取回的作业(schema 4)。判据是 **jobId 得是个非空字符串** —— 没有它什么都做不了,
     存一个没有 id 的对象只会让界面挂出一个点了没用的「重试取回」。
     类型判得**严**:数字 42 不再换算成 "42"(那是一份手改过的记录,照它去问只会一直 404);
     与 shapePose / shapeView 同一条口径 —— 类型不对就整份丢掉,不猜。
     其余三个字段是给人看的(哪条路、哪个提交编号、什么时候交的),缺了给默认值就行。 */
  function shapePending(raw) {
    var value = raw && typeof raw === "object" ? raw : {};
    if (typeof value.jobId !== "string") return null;
    var jobId = value.jobId.trim();
    if (!jobId) return null;
    return {
      jobId: jobId,
      task: String(value.task || ""),
      requestId: String(value.requestId || ""),
      createdAt: Number(value.createdAt) || 0
    };
  }

  function shapeDocument(raw) {
    var value = raw && typeof raw === "object" ? raw : {};
    return {
      pose: shapePose(value.pose),
      view: shapeView(value.view),
      modelId: String(value.modelId || ""),
      figure: String(value.figure || ""),
      render: shapeRender(value.render)
    };
  }

  function snapshot() {
    var source = documentNow();
    return {
      schema: 4,
      id: app.state.workId,
      title: app.state.workTitle,
      prompt: app.state.prompt,
      promptEn: promptPair(),
      negativePrompt: app.state.negativePrompt,
      createdAt: 0,
      updatedAt: Date.now(),
      results: (app.state.results || []).map(storedResult).filter(function (item) { return Boolean(item); }),
      /* 这一件作品长什么样:姿态、视口、模型卡、造型、成图的调色 */
      pose: shapePose(source.pose),
      view: shapeView(source.view),
      modelId: String(source.modelId || ""),
      figure: String(source.figure || ""),
      render: shapeRender(source.render),
      /* 交出去、还没取回来的那个作业(见 shapePending 上面的注释) */
      pending: shapePending(app.state.pendingJob)
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
      results: [],
      /* 作品文档里的那五样:姿态 / 视口 / 模型卡 / 造型 / 成图调色(schema 3 的最后一个)。
         schema 1 的旧作品读出来是五样皆空 —— 装配层据此把人偶摆回出厂状态。 */
      pose: shapePose(record.pose),
      view: shapeView(record.view),
      modelId: String(record.modelId || ""),
      figure: String(record.figure || ""),
      render: shapeRender(record.render),
      /* schema 4 的第六样。旧作品没有这个字段 ⇒ null,也就是"没有待取回的作业" */
      pending: shapePending(record.pending)
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

  /* 把一份作品装进运行时状态。
   *
   * `options.document === true` 表示**整份文档换了**(换作品 / 开新作品 / 删掉当前作品),
   * 这时才把姿态、视口、模型卡、造型也一起装回去,并广播 work:loaded。
   * 默认(false)只是"这几个字变了"(改标题、改描述)—— 那种调用只刷新界面上的字。
   *
   * 为什么必须分开:改一次标题也会走这里。不加这个开关,用户每改一次标题,
   * 人偶就会被摆回出厂姿势 —— 而他在屏幕上正看着自己刚摆好的姿势。
   * 同理 app.state.document 在此时**保持原样**,否则紧接着的一次 snapshot 会把
   * 姿态、视口、模型卡、造型一起写成空值。 */
  function applyToState(work, options) {
    app.state.workId = work ? work.id : "";
    app.state.workTitle = work ? work.title : "";
    app.state.prompt = work ? work.prompt : "";
    app.state.promptEn = work ? shapePair(work.promptEn) : null;
    app.state.negativePrompt = work ? work.negativePrompt : "";
    app.state.results = work ? work.results : [];
    var whole = Boolean(options && options.document === true);
    if (whole) {
      app.state.document = work ? shapeDocument(work) : null;
      /* 待取回的作业跟着**整份文档**走,而不是每次刷新都跟着走。
         为什么:`updateWork`(改标题 / 改描述)也走这里,而它递上来的是**手搭的六个字段**
         —— 跟着走就等于"用户改一次标题,唯一能取回那张图的 id 就没了",而且不报任何错。 */
      app.state.pendingJob = work ? shapePending(work.pending) : null;
    }
    rememberWork(app.state.workId);
    app.events.emit("work:changed", { id: app.state.workId, title: app.state.workTitle });
    if (whole) {
      app.events.emit("work:loaded", {
        id: app.state.workId,
        title: app.state.workTitle,
        document: app.state.document
      });
    }
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

  /* 译文的落盘规则,一处。`values.english` 是**调用方明确指定的一份译文** ——
     现在界面上已经没有那个英文输入框了(2026-09-30 定稿:翻译改成提交时自动做),
     但这条入口留着:它仍然说明"有指定就按指定的存",而不是回头去缓存里取一句旧的。
     没递(undefined)或者递了空串时不覆盖已有的译文:缓存里正好有这句的新译文就顺手挂上,
     **绝不用一次手滑把译文清掉**。 */
  function pairFor(prompt, values) {
    var override = Boolean(values) && values.english !== undefined && values.english !== null
      ? String(values.english).trim() : "";
    return app.services.translate.pair(prompt, override) || null;
  }

  /* 界面有没有递英文译文过来(递了空串也算"递了") */
  function hasEnglish(values) {
    return Boolean(values) && values.english !== undefined && values.english !== null;
  }

  /* 改一件作品的标题 / 角色描述 / 英文译文。改的是"当前作品"就地生效并落盘;
     改别人就先读出来改完写回,并同步索引里的那几行(列表要显示标题与描述)。
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
      if (hasPrompt) app.state.prompt = String(values.prompt);
      /* 描述一改旧译文就作废;界面递了新译文就用它,否则看缓存里有没有这句 */
      if (hasPrompt || hasEnglish(values)) app.state.promptEn = pairFor(app.state.prompt, values);
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
    if (hasPrompt) record.prompt = String(values.prompt);
    if (hasPrompt || hasEnglish(values)) record.promptEn = pairFor(record.prompt, values);
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
    applyToState(await hydrate(record), { document: true });
    return app.state;
  }

  /* 新作品:先把当前这件存好,再开一份空的。
     标题留空就当场取「未命名作品 N」—— 不拖到第一次保存时才取名,
     因为"添加作品"之后它就该出现在作品列表里,哪怕还一个字都没写。
     角色描述不传就取默认值;显式传空串表示用户清空了它,照样允许。 */
  async function newWork(title, prompt) {
    await flush();
    var value = prompt === undefined || prompt === null ? defaultPrompt() : String(prompt);
    /* 新作品是一份**空文档**:四样都不给 ⇒ 装配层把人偶摆回出厂站姿、相机回出厂取景
       (2026-09-30 用户要求:「新建作品,建好并打开,要把当前人偶恢复开始的初始姿势」)。
       负向提示词沿用当前这件 —— 它是模型设置性质的一行,不是这件作品的创意。 */
    applyToState({
      id: app.utils.id("work"),
      title: String(title || "").trim() || untitledTitle(),
      prompt: value,
      /* 默认描述是句中文,译英缓存里可能已经有它了(比如上一件作品刚翻过) */
      promptEn: app.services.translate.pair(value, ""),
      negativePrompt: app.state.negativePrompt,
      results: []
    }, { document: true });
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
    /* 删掉的正是当前这件 ⇒ 状态整个清空,人偶也回出厂(没有作品就没有"它的姿态"了) */
    if (app.state.workId === id) applyToState(null, { document: true });
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
    shapeDocument: shapeDocument,
    /* 待取回的作业那一条的形状收口 —— 与 shapeDocument 同一个理由:导出是给
       tests/work.test.mjs 用的,半份记录不许"装作能取"。 */
    shapePending: shapePending,
    attachDocument: attachDocument,
    shareChp: shareChp,
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
