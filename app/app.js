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

  /* 给生图引擎的截图口:正方形参考图。
     交给模型的永远是同一张 1024 边的干净渲染图,与模型卡自己的画幅无关。

     编码是 JPEG 而不是 PNG,因为这张图要**整个塞进请求体**发给模型:宿主单条消息
     200000 字符封顶(见 platform/haminn.js 的 MESSAGE_CHARS),而 1024 的 PNG 截图
     在真机上量出来是 233750 字符 —— 会被自家的 checkBudget 直接拦下,报
     "超过宿主单次请求上限",连网都出不去。同一张图 JPEG(0.92)只有 62659 字符。
     3D 渲染是一大片平滑渐变,JPEG 的损失落在扩散模型的参考图里看不出来;
     0.92 这个值也是量出来的:0.85 只有 44091 字符,但没必要为了省一半体积再降一档画质。 */
  function captureSquare(size) {
    var value = Math.max(64, Math.round(Number(size) || app.config.reference.size));
    return app.components.viewport.captureAt(value, value, { format: "image/jpeg", quality: 0.92 });
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
    app.services.imageEngine.init({ capture: captureSquare });
    app.features.poser.init();
    wireViewport();
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

  /* 设备端验收用的可读状态:haminn_get_page_state 读这里的第二个返回值 */
  window.posegiDevState = {
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
          return { id: item.id, name: item.name, protocol: item.protocol, task: item.task, size: item.size, refStrength: item.refStrength, endpoint: item.endpoint, active: item.id === app.config.activeModelId };
        }),
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
          var values = app.services.providers.preset(item.protocol || "cvp", item.task || "quick");
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
          return { id: item.id, name: item.name, protocol: item.protocol, task: item.task, size: item.size, endpoint: item.endpoint, active: item.id === saved.activeModelId };
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

    /* 直接打一次模型连接测试(不生成图片) */
    testModel: function (id) {
      var model = id ? app.services.providers.byId(String(id)) : app.services.providers.active();
      return app.services.providers.test(model).then(function (value) {
        return { ok: value.ok, task: value.task || "", model: value.model || "" };
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.posegi);
