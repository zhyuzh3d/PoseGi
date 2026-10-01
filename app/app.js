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

  /* ---------- 作品文档 ↔ 运行时 ----------
   *
   * 一件作品里那几样"它长什么样"的东西(姿态 / 视口 / 模型卡 / 造型 / 成图调色)分别由
   * poser、viewport、providers、figure、renderPreview 持有,store 只认它们的**形状**。
   * 于是两个方向都在这里接:
   *
   *   存 —— 把取数函数交给 store(它写作品记录时来问"现在是什么样");
   *   取 —— 监听 work:loaded,把装进来的那一份分发给这几个模块。
   *
   * 只有"整份文档换了"才会收到 work:loaded(见 store.applyToState 的注释):
   * 改标题、改描述不该把人偶摆回出厂姿势。
   */
  function wireWorkDocument() {
    app.services.store.attachDocument(function () {
      return {
        pose: app.features.poser.snapshot(),
        view: app.components.viewport.view(),
        modelId: app.config ? String(app.config.activeModelId || "") : "",
        figure: app.features.figure.current(),
        /* 调色是"活的那一份"由全屏看图持有(和姿态归 poser 一个道理) */
        render: app.components.renderPreview.adjustments()
      };
    });
    app.events.on("work:loaded", function (detail) {
      applyDocument(detail && detail.document);
    });
    /* 在全屏看图里拖一下滑杆 ⇒ 记进当前作品并安排落盘。
       镜像到 app.state.document 那一份是为了设备端读数与快照:**持有者是 renderPreview**,
       这里只是跟着它走的一份(与 poser ↔ document.pose 同一个关系)。 */
    app.events.on("render:adjusted", function (detail) {
      if (app.state.document) app.state.document.render = detail;
      app.services.store.scheduleSave();
    });
  }

  function applyDocument(document) {
    var doc = document && typeof document === "object" ? document : {};
    /* 顺序不能换:**造型 → 姿态 → 视口**。
       换造型那一层会连带复位姿态、并且重新取景(figure.apply 就是这么写的),
       所以它必须排第一;视口排最后,否则会被前面那一步的取景覆盖掉。
       缺的那几样各自回出厂 —— 这正是"新建作品恢复初始姿势"走的那条路。 */
    if (doc.figure) app.features.figure.apply(doc.figure);
    if (doc.pose) app.features.poser.restore(doc.pose);
    else app.features.poser.reset();
    if (doc.view) app.components.viewport.applyView(doc.view);
    else app.components.viewport.resetView();
    /* 调色:没有就是回中性(新建作品 / schema 2 的老作品都走这一条) */
    app.components.renderPreview.setAdjustments(doc.render);
    restoreModel(doc.modelId);
  }

  /* 打开作品时它用的那张模型卡可能已经不在了(用户在设置里把它删了,或者配置换代)。
     那就**弹窗说清并把人送去重新选一张**,同时把激活卡落到清单第一张
     (2026-09-30 用户要求:「如果打开时候找不到对应模型就弹窗提示需要重新选择模型
     (默认选定模型列表第一个)」)。
     为什么不静默回落:用户打开旧作品、按下生成,出来的图却不是他当初那张卡画的,
     而错在哪他看不出来 —— 这件事必须说出来。
     schema 1 的旧作品没存模型卡(modelId 为空串)时不打扰:那是"没有意见",不是"找不到"。 */
  function restoreModel(modelId) {
    var config = app.config;
    var wanted = String(modelId || "");
    if (!config || !wanted) return;
    if (app.services.providers.byId(wanted)) {
      if (String(config.activeModelId || "") !== wanted) activateModel(wanted);
      return;
    }
    var fallback = (config.models || [])[0];
    if (fallback) activateModel(fallback.id);
    app.components.ui.confirm({
      title: app.i18n.text("这件作品用的模型卡不在了", "This artwork's model card is gone"),
      message: app.i18n.text("生成时会用列表里的第一张卡。要换成别的,先去模型列表选一张。",
        "Generation will use the first card in the list. Pick another one in the model list first."),
      okText: app.i18n.text("去设置模型", "Choose a model"),
      cancelText: app.i18n.text("知道了", "Got it")
    }).then(function (go) {
      if (go) app.components.settings.openModels();
    });
  }

  /* 切激活卡 = 改配置 + 立刻落盘(配置保存本身是防抖的,但"哪张卡在用"值得当场写下去:
     用户下一件事多半就是按生成,而那一下读的是 app.config)。 */
  function activateModel(id) {
    var next = String(id || "");
    if (!app.config || !next) return;
    app.config.activeModelId = next;
    app.state.activeModelId = next;
    app.services.store.saveConfig(app.config).catch(function () {});
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

  /* 给生图引擎的截图口:9:16、高度 1024 的**彩色骨架参考图**(2026-10-01 改)。
     为什么交出去的是一张骨架、而不是 3D 视口的截图:Qwen-Image 2.1 那条路上参考图
     就是控制图,而它**长什么样决定了被当成什么** —— 白底黑线会被认成"待临摹的线稿"
     (出图就是那张线稿的再渲染,提示词完全失效),素模灰度图会被认成"那个木头人偶"
     (出图就是那个人偶);只有**黑底 + 每条肢体一个 OpenPose 颜色 + 关节圆点 +
     小尺度脸点阵**,模型才把它认成 **pose**,然后按提示词去生成"一个真人摆这个姿势"。
     长相与那几处参数全部在 app/core/skeleton.js 里(它的头注释写了每条参数的来历)。

     取景与裁切与从前一模一样(先按 reference.canvasWidth/canvasHeight 取景、
     再居中裁成 9:16、缩到目标尺寸),所以骨架落在与人偶**同一次取景**里;
     屏上那层覆盖 canvas 用的是同一套投影,只是宽高比跟着屏幕走(见 viewport 的
     彩色骨架覆盖层 一节)。

     编码是 PNG 而不是 JPEG:骨架是一张大面积纯黑的图,PNG 压得极小 ——
     576×1024 那一张在真 Chrome 里量出来只有 57518 个字符(整个响应体的上限是 200000),
     而骨线是硬边,JPEG 会在边上糊出一圈灰,那正是"线稿"的观感,不该为省几 KB 糊掉控制图。 */
  function captureReference() {
    var reference = app.config.reference || app.defaults.reference;
    return app.components.viewport.skeletonImage(reference.canvasWidth, reference.canvasHeight, {
      frame: { width: reference.width, height: reference.height }
    });
  }

  /* 打开"上次用的那件作品";一件作品都没有就弹「添加作品」(2026-09-25 用户要求)。
   *
   * 三件事各归各处:
   *   - 「上次用哪件」记在配置的 preferences.lastWorkId 里(store 在换作品时写);
   *   - 指向的作品已经被删掉时退回列表里最新的一件,而不是报错;
   *   - 一件都没有(全新装机)才弹表单 —— 用户原话「如果是第一次启动,就弹窗添加作品」。
   * 放在自检之后:这两个动作都会开弹层,先让自检跑完,免得启动中途弹出来的面板
   * 被自检的写操作打断。 */
  async function openStartupWork() {
    try {
      var list = app.services.store.listWorks();
      if (!list.length) {
        app.features.editor.openAddWorkSheet({ firstRun: true });
        return null;
      }
      var last = app.services.store.lastWorkId();
      var target = list.filter(function (item) { return item.id === last; })[0] || list[0];
      await app.services.store.openWork(target.id);
      app.features.editor.status(app.i18n.text("当前作品:", "Current artwork: ") + app.state.workTitle);
      return target.id;
    } catch (error) {
      app.events.emit("error", error);
      return null;
    }
  }

  async function start() {
    app.components.ui.init();
    app.events.on("error", function (error) { app.components.ui.toast(app.utils.cleanError(error), "error"); });

    await app.services.store.loadConfig();
    app.i18n.setLanguage(app.config.preferences.language);
    app.i18n.theme();
    /* 译英缓存在数据区里,启动时读一次就够(见 services/translate.js 的 load)。
       读不到不影响任何事:没有缓存只是"这句话要多翻一次"。 */
    await app.services.translate.load().catch(function () {});

    /* 先把配置里记着的造型装进骨架,再建视口 —— 视口初始化时直接读到装好的关节表,
       于是外带模型不需要"先建一遍再换一遍" */
    app.features.figure.init();

    app.components.viewport.init(document.getElementById("stage-viewport"));
    app.components.viewport.setTheme(app.state.theme);
    app.services.imageEngine.init({ capture: captureReference });
    app.features.poser.init();
    wireViewport();
    wireWorkDocument();
    app.components.renderPreview.init();
    app.components.settings.init();
    app.features.editor.init();
    app.features.editor.status(app.features.editor.defaultStatus());

    app.platform.haminn.appReady();
    app.platform.haminn.reportTheme();
    lockPortrait();

    await app.features.selfTest.run();
    await openStartupWork();
  }

  window.addEventListener("error", function (event) {
    if (event.error) app.events.emit("error", event.error);
  });
  window.addEventListener("unhandledrejection", function (event) {
    app.events.emit("error", event.reason || new Error("异步操作失败"));
  });

  /* 设备端验收用的可读状态。**钩子名是宿主合同定死的**:`haminn_get_page_state`
     读的是 `window.haminnDevState.capture()`,见 haminnapp 的 docs/webapp-authoring.md
     「普通 happ 可按以下固定合同提供自己的恢复机制」。
     这里原来只挂了 `window.posegiDevState`,于是宿主那一侧读到的永远是 null ——
     整套读数在设备上从来没生效过。现在两个名字都挂上:`haminnDevState` 是合同名,
     `posegiDevState` 是本仓 guid.md 与工具链一直用的旧名,留着当别名。 */
  window.haminnDevState = {
    capture: function () {
      var viewport = app.components.viewport;
      return {
        version: app.version,
        theme: document.documentElement.dataset.theme,
        language: app.i18n.language(),
        languagePreference: app.i18n.preferred(),
        selectedJoint: app.state.selectedJoint,
        selectedPart: app.state.selectedPart,
        poseName: app.state.poseName,
        dirty: app.state.dirty,
        busy: app.state.busy,
        status: app.state.status,
        work: {
          id: app.state.workId, title: app.state.workTitle, results: (app.state.results || []).length,
          prompt: String(app.state.prompt || "").slice(0, 60),
          promptEn: String((app.state.promptEn || {}).text || "").slice(0, 60),
          lastWorkId: app.services.store.lastWorkId(),
          works: app.services.store.listWorks().length
        },
        /* 当前作品文档里那五样(姿态 / 视口 / 模型卡 / 造型 / 成图调色)。
           设备端"存了没、装回来没"就看这里:姿态报的是关节个数与预设名,
           整份角度表太长,而在屏幕上真正要对上的是"装回来的那个视角、那张卡,
           以及那一套调色"。
           调色报**两份**:`render` 是作品文档里那份,`renderLive` 是全屏看图手上那份。
           两份不一致就是"装回来的时候没推过去" —— 那种断法界面上完全看不出来
           (滑杆还是能拖、图还是能看,只是打开旧作品调色没跟着回来)。 */
        document: app.state.document ? {
          poseJoints: app.state.document.pose ? Object.keys(app.state.document.pose.angles).length : 0,
          poseName: app.state.document.pose ? app.state.document.pose.name : "",
          view: app.state.document.view,
          modelId: app.state.document.modelId,
          figure: app.state.document.figure,
          render: app.state.document.render,
          renderLive: app.components.renderPreview.adjustments()
        } : null,
        translate: {
          enabled: Boolean(app.config && app.config.translate && app.config.translate.enabled),
          endpoint: String(app.config && app.config.translate && app.config.translate.endpoint || ""),
          resolved: (function () {
            var item = app.services.translate.internals.connection();
            return item ? item.endpoint : "";
          })(),
          cached: Object.keys(app.services.translate.internals.cache).length
        },
        models: (app.config && app.config.models || []).map(function (item) {
          /* `task` 就是插件文档里的 `category`(chp/2 没有别名),`resolution` 是真正会
             发出去的那个字面量 —— CHP 卡上它是从插件帧表挑出来的,不是卡里存的那个数。 */
          return { id: item.id, name: item.name, protocol: item.protocol, task: item.task, category: item.task,
            resolution: app.services.providers.resolutionText(item),
            refStrength: item.refStrength, endpoint: item.endpoint, active: item.id === app.config.activeModelId };
        }),
        viewport: { available: viewport.available(), reason: viewport.reason() },
        figure: { id: app.features.figure.current(), figure: viewport.figure() },
        scene: { mode: viewport.mode(), counts: viewport.counts(), view: viewport.view(), body: viewport.body() },
        stage: window.haminnDevState.stage(),
        pose: (function () {
          var angles = app.features.poser.angles();
          var flat = {};
          ["broot", "hips", "spine", "chest", "head", "shoulder.L", "upperArm.L", "forearm.L", "thigh.L", "shin.L", "foot.L"].forEach(function (name) {
            flat[name] = [angles[name].x, angles[name].y, angles[name].z];
          });
          return flat;
        })(),
        bridge: app.platform.haminn.available(),
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

    /* 毛玻璃到底有没有被真机认下来 —— 2026-09-30 加"所有毛玻璃压一层黑纱"时补的读数。
     *
     * 为什么要在设备上量一次:`--glass` 从"一个颜色"变成了"两层背景"(`linear-gradient`
     的黑纱 + 白色底),写法一旦被内核丢掉,**整条 `background` 声明都会失效** ——
     面板会变成全透明压在 3D 场景上,字看不清,而源码里一个字都没错、门禁也全绿
     (静态检查看的是源文件,不是内核解析的结果)。
     * getComputedStyle 报的是**解析之后**的值,所以它答的正是"这台机器认不认": 
     `backgroundImage` 里应当出现那层渐变,`backgroundColor` 里应当是那个白。 */
    glass: function () {
      /* 取的是**真的毛玻璃面**:`.topbar` 只是一条透明的定位容器(它自己
         `background: transparent` 且没有 backdrop-filter),玻璃卡片是它里面的
         `.topbar-card` —— 探针挑错了元素就会拿到"透明的背景",看起来像"压暗没生效"。 */
      var probe = document.querySelector(".topbar-card") || document.querySelector(".modal-sheet") ||
        document.querySelector(".app-menu");
      var root = document.documentElement;
      if (!probe) return null;
      var style = window.getComputedStyle(probe);
      return {
        element: "." + String(probe.className || "").split(" ")[0],
        /* 两套主题各自那个量(唯一旋钮),以及压在它上面的那一层背景 */
        veil: String(window.getComputedStyle(root).getPropertyValue("--glass-veil") || "").trim(),
        backgroundImage: String(style.backgroundImage || "").slice(0, 100),
        backgroundColor: String(style.backgroundColor || ""),
        backdropFilter: String(style.webkitBackdropFilter || style.backdropFilter || "").slice(0, 60)
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

    /* 设备端配置模型卡:patch 是一组 {id?, name?, ...}。
       没有 id 就新增,有 id 就改那一张 —— 用来把设备上的卡一次配好,不必在手机上点半天。 */
    models: function (patch) {
      var config = app.utils.copy(app.config);
      if (patch && Object.prototype.toString.call(patch) === "[object Array]") {
        patch.forEach(function (item) {
          var next = app.services.store.shapeConfig({ models: [item] }).models;
          var values = app.services.providers.preset(item.protocol || "chp", item.task || "fast");
          Object.keys(item).forEach(function (key) { if (key !== "id") values[key] = item[key]; });
          values.id = String(item.id || values.id);
          var position = -1;
          config.models.forEach(function (current, order) { if (current.id === values.id) position = order; });
          if (position >= 0) config.models[position] = app.utils.merge(config.models[position], values);
          else config.models.push(values);
          void next;
        });
      }
      if (patch && patch.activeModelId) config.activeModelId = patch.activeModelId;
      if (patch && patch.connection) config.connection = app.utils.merge(config.connection, patch.connection);
      return app.services.store.saveConfig(config).then(function (saved) {
        return saved.models.map(function (item) {
          return { id: item.id, name: item.name, protocol: item.protocol, task: item.task, resolution: app.services.providers.resolutionText(item), endpoint: item.endpoint, active: item.id === saved.activeModelId };
        });
      });
    },

    /* 设备端验收:不走界面直接生一张,回来的是这次成图的 id */
    generate: function () {
      return app.services.imageEngine.run().then(function (image) {
        return image ? { id: image.id, bytes: app.utils.dataUrlByteLength(image.src) } : null;
      });
    },

    /* 设备端验收:把「打开上次的作品 / 首次启动弹添加作品」这条路重走一遍。
       传一张作品 id 可以顺带验证"打开指定作品"。 */
    startup: function (id) {
      return id ? app.services.store.openWork(String(id)).then(function () { return app.state.workId; }) : openStartupWork();
    },

    /* 设备端验收:不点按钮直接走一遍截图保存(它会拉起系统保存框,人工点掉即可) */
    captureStage: function () {
      return app.features.editor.captureStage().then(function (result) {
        return result ? { exported: result.exported, cancelled: result.cancelled, name: result.name, bytes: result.bytes } : null;
      });
    },

    /* 译英服务:设备端直接问一次"这句话翻成什么",用来区分是配置不通还是缓存没命中 */
    translate: function (text) {
      var value = String(text === undefined || text === null ? app.state.prompt : text).trim();
      return app.services.translate.translate([value]).then(function () {
        return {
          source: value, english: app.services.translate.english(value),
          cached: app.services.translate.translated(value), hasCjk: app.services.translate.hasCjk(value)
        };
      });
    },

    /* 直接打一次模型连接测试(不生成图片)。
       CHP 卡报的是**从插件文档读到的**事实:协议版本、场景、生效画幅、模型文件。 */
    testModel: function (id) {
      var model = id ? app.services.providers.byId(String(id)) : app.services.providers.active();
      return app.services.providers.test(model).then(function (value) {
        return {
          ok: value.ok, protocol: value.protocol || "", spec: value.spec || "",
          task: value.task || "", category: value.category || value.task || "",
          resolution: value.resolution || "", model: value.model || "", version: value.version || ""
        };
      });
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

  /* 旧名字当别名留着:本仓的 guid.md 与历次真机脚本一直叫它 posegiDevState,
     而它是**同一个对象**(不是第二份读数),所以两边永远不会各说各话。 */
  window.posegiDevState = window.haminnDevState;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.posegi);
