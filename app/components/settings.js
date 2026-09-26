/* 设置:添加模型、模型设置、软件设置、使用说明、软件信息
 *
 * 责任:把 app.config 渲染成表单并写回,以及三个只读的信息页。
 * 约束:API Key 输入框默认遮罩(type=password),不写入日志与测试。
 *       多选一默认用 .choice-row / .chip,不用原生 select;唯一例外是"接口模式" ——
 *       它要"选项名 + 一段长说明",下拉比一列卡片省半屏(2026-09-26 用户要求改的)。
 *
 * 「添加模型」与「模型设置」是两件事:
 *   添加模型 = 建一张新卡(空表单);
 *   模型设置 = 看所有卡,点一张就把它设为生图用的那张。
 * 两者共用同一份表单渲染,所以"编辑已有卡"与"新建卡"的字段永远不会走偏。
 */
(function (app) {
  "use strict";

  var PROJECT_URL = "https://github.com/zhyuzh3d/PoseGi";
  /* 仓库说明里的一行来源:本项目的唯一规范远程 */
  var draft = null;
  /* 编辑中的那份 CVP 连接。CVP 的地址/密码/请求头在配置里**只有一份**,住在
     config.connection 上(store.shareCvp 负责把它分发到每一张 cvp 卡)。表单不能直接
     写 app.config,所以编辑期间先挂在这里,保存时回写到 config.connection。
     **不要再把它挂到 draft 身上** —— 那样 saveModel 很容易忘了回写,而 shareCvp
     紧接着就会拿旧的空 connection 把所有 cvp 卡的地址覆盖成空,
     表现就是"填好地址一保存又变空"(2026-09-26 修掉的就是这个)。 */
  var draftConnection = null;
  /* 这张表单是从哪儿来的:"models" = 从模型列表点进来的,关掉要回列表。
     切协议会重画表单,所以它得记在模块上而不是参数里。 */
  var formBack = "";
  var editingId = "";

  function t(zh, en) { return app.i18n.text(zh, en); }
  function esc(value) { return app.utils.escapeHtml(value); }
  function ui() { return app.components.ui; }

  function init() { return true; }

  /* ---------- 表单零件 ---------- */

  function field(name, label, value, type, placeholder) {
    return '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + (type || "text") +
      '" value="' + esc(value === null || value === undefined ? "" : value) + '" placeholder="' + esc(placeholder || "") + '"></label>';
  }

  function rangeField(name, label, value, minimum, maximum, step, suffix, hint) {
    return '<label class="field range-field"><span>' + label + ' <strong data-range-label="' + name + '">' + value + (suffix || "") +
      "</strong></span>" + (hint ? '<em class="range-hint">' + hint + "</em>" : "") +
      '<input name="' + name + '" type="range" min="' + minimum + '" max="' + maximum + '" step="' + (step || 1) +
      '" value="' + value + '" data-suffix="' + (suffix || "") + '"></label>';
  }

  function bindRanges(root) {
    Array.prototype.forEach.call(root.querySelectorAll('input[type="range"]'), function (input) {
      input.addEventListener("input", function () {
        var output = root.querySelector('[data-range-label="' + input.name + '"]');
        if (output) output.textContent = input.value + (input.dataset.suffix || "");
      });
    });
  }

  /* 通用下拉。外面那层 .select-wrap 只为了画右下角那个三角 —— select 自己没法上
     伪元素,而背景图里的颜色又吃不到主题变量。entries 形如 [[value, label], …]。 */
  function selectRow(name, entries, current) {
    return '<span class="select-wrap"><select name="' + esc(name) + '" class="select-input">' +
      entries.map(function (entry) {
        return '<option value="' + esc(entry[0]) + '"' + (entry[0] === current ? " selected" : "") + ">" +
          esc(entry[1]) + "</option>";
      }).join("") + "</select></span>";
  }

  /* 接口模式:原生下拉(2026-09-26 用户要求「改下拉选择」)。
     它原来是四个 .choice-row 按钮,每个带一段说明,竖着占掉半屏;而"选哪一个"
     本身是件一眼就能看完的事,下拉更合适。说明文字改成只显示当前选中那一项的,
     放在下拉下面一行 —— 四个协议各说一段话,排在一起反而没人读。 */
  function protocolSelect(current) {
    return selectRow("protocol", app.services.providers.protocols.map(function (item) {
      return [item.id, item.name];
    }), current);
  }

  function protocolDescription(id) {
    var found = app.services.providers.protocols.filter(function (item) { return item.id === id; })[0];
    return found ? String(found.description || "") : "";
  }

  /* ---------- 添加模型 / 编辑模型 ---------- */

  /* back:"models" = 关掉这张卡之后回到模型列表(从列表里点进来的都是这个);
     不传 = 关掉就完事 —— 菜单里的「添加模型」直接进表单,下面没有上一层。 */
  function openAddModel(back) { openModelForm(null, back); }

  function openModelForm(id, back) {
    editingId = String(id || "");
    formBack = String(back || "");
    var source = editingId ? app.services.providers.byId(editingId) : null;
    draft = source ? app.utils.copy(source) : app.services.providers.preset("cvp", "quick");
    if (!source) draft.name = "";
    /* 每次打开都重取一份连接,上一次编辑留下的值不能漏到这一次 */
    draftConnection = null;
    renderModelForm();
  }

  /* 画幅固定的任务(快速只有 512、渲染只有 1024)不摆一条拖不动的滑杆,
     直接把数值写出来;隐藏的 input 还在,readForm 照旧读得到这一个字段。 */
  function fixedField(name, label, value, suffix, hint) {
    return '<label class="field"><span>' + label + " <strong>" + value + (suffix || "") + "</strong></span>" +
      (hint ? '<em class="range-hint">' + hint + "</em>" : "") +
      '<input type="hidden" name="' + name + '" value="' + value + '"></label>';
  }

  /* 任务三选一。选项与说明都从 app.defaults.cvpTasks 派生,加任务只改那一份表。 */
  function cvpTaskChips(current) {
    var internals = app.services.providers.internals;
    return Object.keys(app.defaults.cvpTasks).map(function (id) {
      return '<button type="button" class="chip' + (id === internals.cvpTask({ task: current }) ? " is-on" : "") +
        '" data-task="' + esc(id) + '">' + esc(internals.taskName(id)) + "</button>";
    }).join("");
  }

  function cvpTaskHelp(task) {
    if (task === "upscale") return t("把手上的 1024 渲染图放大补细节,构图基本不动。", "Upscales the 1024 render and adds detail; the composition stays put.");
    if (task === "qwen") return t("Qwen-Image 2.1 按参考图重新作画,是这里最重、也最像成片的一档;单张几十秒。", "Qwen-Image 2.1 repaints from the reference. The heaviest task here and the one that looks most like a finished photo; tens of seconds per image.");
    return t("最快的草图路线,512 画幅,一两秒出图,适合先看构图。", "The fastest sketch path: 512 px, a second or two, good for checking the composition.");
  }

  function renderModelForm() {
    var cvp = draft.protocol === "cvp";
    var limits = app.defaults.limits;
    var html = '<div class="field"><span>' + t("接口模式", "API format") + "</span>" + protocolSelect(draft.protocol) +
      '<p class="field-help" data-protocol-help>' + esc(protocolDescription(draft.protocol)) + "</p></div>";
    html += field("name", t("模型卡名称", "Card name"), draft.name, "text", t("例如:家里的 ComfyUI", "For example: ComfyUI at home"));
    if (cvp) {
      html += '<div class="field"><span>' + t("任务", "Task") + '</span><div class="chip-row">' +
        cvpTaskChips(draft.task) + "</div>" +
        '<p class="field-help">' + cvpTaskHelp(draft.task) + "</p></div>";
    }
    /* CVP 的地址只有一份(shared()),它为空就说明这台设备还没记录过 ——
       这时预填那条样例地址,用户只改 IP 就行;已经记录过就原样显示,绝不覆盖
       (2026-09-26 用户要求)。 */
    html += field("endpoint", t("服务器地址", "Server address"),
      cvp ? (shared().endpoint || app.defaults.cvpEndpoint) : draft.endpoint, "url",
      cvp ? app.defaults.cvpEndpoint : "https://…");
    html += '<label class="field"><span>' + (cvp ? t("访问密码", "Access password") : "API Key") + "</span>" +
      '<div class="secret-input"><input name="apiKey" type="password" autocomplete="off" value="' +
      esc(cvp ? shared().apiKey : draft.apiKey) + '" placeholder="' +
      esc(cvp ? t("在 ComfyUI 的 VibeDraw 配置节点里设置;留空表示插件没有启用密码", "Set it in the ComfyUI VibeDraw config node; leave empty when the plugin has no password") : t("免鉴权的本地服务可留空", "Optional for local services")) +
      '"><button type="button" data-toggle-secret aria-label="' + t("显示密钥", "Show key") + '"><i class="fa-regular fa-eye" aria-hidden="true"></i></button>' +
      '<button type="button" data-paste-secret aria-label="' + t("粘贴密钥", "Paste key") + '"><i class="fa-regular fa-paste" aria-hidden="true"></i></button></div></label>';
    if (cvp) {
      html += '<p class="field-help">' + t("所有 CVP 模型卡共用这一套地址与密码:在这里改,几张卡一起改。", "Every CVP card shares this one address and password: change it here and all of them change together.") + "</p>";
    } else {
      html += field("model", t("模型 ID", "Model ID"), draft.model, "text", t("填写服务提供的模型名称", "Model name from your provider"));
    }
    /* CVP 的画幅档位由任务的 capabilities 决定 —— quick 只有 512、渲染只有 1024、
       Qwen 是 512–1024 每 64 一档,所以滑杆的范围随任务变(见 providers.cvpSize)。 */
    var sizeSpec = app.services.providers.internals.cvpSpec(draft.task).size;
    var sizeLow = cvp ? Math.max(sizeSpec[0], limits.size[0]) : limits.size[0];
    var sizeHigh = cvp ? Math.min(sizeSpec[1], limits.size[1]) : limits.size[1];
    if (cvp && sizeLow === sizeHigh) {
      html += fixedField("size", t("生成分辨率", "Output size"), sizeLow, "px",
        t("这个任务只有这一档画幅", "This task has a single canvas size"));
    } else {
      html += rangeField("size", t("生成分辨率", "Output size"), draft.size, sizeLow, sizeHigh, cvp ? sizeSpec[2] : 64, "px",
        t("正方画幅,边长的像素数", "Square canvas, side length in pixels"));
    }
    html += rangeField("refStrength", t("参考图强度", "Reference strength"), draft.refStrength, limits.refStrength[0], limits.refStrength[1], 10, "",
      draft.task === "qwen"
        ? t("100 为中性:参考图原样交给模型;调低会把它逐步柔化,让提示词接手", "100 is neutral: the model sees the reference as it is. Lower softens it so the prompt takes over")
        : t("100 为中性:调高更贴渲染图,调低给模型更多自由", "100 is neutral: higher sticks closer to the render, lower frees the model"));
    html += '<details class="advanced"><summary>' + t("高级参数", "Advanced") + "</summary>" +
      rangeField("steps", t("步数", "Steps"), draft.steps, limits.steps[0], limits.steps[1], 1, "", "") +
      field("timeoutMs", t("超时(毫秒)", "Timeout (ms)"), draft.timeoutMs, "number") +
      '<label class="field"><span>' + t("自定义请求头 JSON", "Custom headers JSON") +
      '</span><textarea name="customHeaders" rows="2" placeholder="{&quot;X-API-Key&quot;:&quot;your-key&quot;}">' +
      esc(cvp ? shared().customHeaders : draft.customHeaders) + "</textarea></label></details>";
    html += '<div class="form-actions"><button class="button button-secondary" type="button" data-test><i class="fa-solid fa-plug" aria-hidden="true"></i>' +
      t("测试连接", "Test connection") + '</button><button class="button button-primary" type="button" data-save>' +
      t("保存", "Save") + "</button></div>";
    html += '<p class="connection-status" data-test-status></p>';
    html += '<p class="field-help">' + t("只向你配置的服务发送画面。局域网支持 HTTP;密码只在保存后存进当前应用。",
      "Images go only to your configured service. LAN HTTP is supported. Passwords are stored in this app after you save.") + "</p>";

    var root = ui().openSheet({
      eyebrow: t("生成", "Generation"),
      title: editingId ? t("编辑模型卡", "Edit model card") : t("添加模型", "Add model"),
      bodyHtml: html,
      /* 保存或关掉这张卡之后回到模型列表 —— 用户是从列表点进来的,
         不该一脚被踢回 3D 视口(2026-09-26 用户要求)。 */
      onClose: formBack === "models" ? function () { openModels(); } : null,
      onMount: function (content) {
        bindRanges(content);
        /* 换接口模式要重建表单(不同协议的字段本来就不一样:cvp 有任务与共用连接,
           别的协议有模型 ID),但**先把已经填好的东西收进 draft** ——
           否则用户填完地址再动一下模式,地址就白填了。 */
        var protocol = content.querySelector('[name="protocol"]');
        if (protocol) protocol.onchange = function () {
          readForm(content);
          var next = app.services.providers.preset(protocol.value, draft.task);
          next.id = draft.id;
          next.name = draft.name;
          next.endpoint = draft.endpoint;
          next.apiKey = draft.apiKey;
          next.customHeaders = draft.customHeaders;
          next.needsEnglish = draft.needsEnglish === true;
          draft = next;
          renderModelForm();
        };
        Array.prototype.forEach.call(content.querySelectorAll("[data-task]"), function (button) {
          button.onclick = function () {
            var next = app.services.providers.preset(draft.protocol, button.dataset.task);
            next.id = draft.id;
            next.name = draft.name;
            next.endpoint = draft.endpoint;
            next.apiKey = draft.apiKey;
            next.needsEnglish = draft.needsEnglish === true;
            draft = next;
            renderModelForm();
          };
        });
        bindSecrets(content, function () { return draft; });
        content.querySelector("[data-save]").onclick = ui().action(saveModel);
        content.querySelector("[data-test]").onclick = ui().action(function () {
          return testModel(content);
        });
      }
    });
    return root;
  }

  /* 编辑期间那份 CVP 连接:第一次问它时按 app.config.connection 取一份副本,
     之后表单里的改动都落在这一份上,保存时由 saveModel 回写。 */
  function shared() {
    if (!draftConnection) {
      draftConnection = app.utils.merge({ endpoint: "", apiKey: "", customHeaders: "" }, app.config.connection || {});
    }
    return draftConnection;
  }

  /* 密钥输入框的两个按钮:眼睛(显隐)与粘贴。粘贴要在确认后才落盘,所以只写进表单 */
  function bindSecrets(content, getModel) {
    var model = getModel();
    var input = content.querySelector('[name="apiKey"]');
    var cvp = model && model.protocol === "cvp";
    function write(value) {
      if (cvp) shared().apiKey = value;
      else draft.apiKey = value;
    }
    var toggle = content.querySelector("[data-toggle-secret]");
    if (toggle) toggle.onclick = function () {
      var reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      toggle.setAttribute("aria-label", reveal ? t("隐藏密钥", "Hide key") : t("显示密钥", "Show key"));
      toggle.innerHTML = '<i class="fa-regular fa-' + (reveal ? "eye-slash" : "eye") + '" aria-hidden="true"></i>';
    };
    var paste = content.querySelector("[data-paste-secret]");
    if (paste) paste.onclick = ui().action(async function () {
      input.value = String(await app.platform.hermit.clipboardRead()).trim();
      write(input.value);
    });
  }

  /* 把表单读回 draft。范围与数字一律转成数,空值回落默认 —— 存进去的必须是可算的。 */
  function readForm(content) {
    var cvp = draft.protocol === "cvp";
    var name = content.querySelector('[name="name"]');
    if (name) draft.name = name.value.trim();
    var endpoint = content.querySelector('[name="endpoint"]').value.trim();
    var apiKey = content.querySelector('[name="apiKey"]').value;
    var headers = content.querySelector('[name="customHeaders"]').value;
    if (cvp) {
      shared().endpoint = endpoint;
      shared().apiKey = apiKey;
      shared().customHeaders = headers;
      draft.endpoint = endpoint; draft.apiKey = apiKey; draft.customHeaders = headers;
    } else {
      draft.endpoint = endpoint; draft.apiKey = apiKey; draft.customHeaders = headers;
    }
    var model = content.querySelector('[name="model"]');
    if (model) draft.model = model.value.trim();
    draft.size = Number(content.querySelector('[name="size"]').value);
    draft.refStrength = Number(content.querySelector('[name="refStrength"]').value);
    draft.steps = Number(content.querySelector('[name="steps"]').value);
    draft.timeoutMs = Number(content.querySelector('[name="timeoutMs"]').value);
    return draft;
  }

  /* 插件自报的信息落到这张卡上。
     目前只做一件事 —— 把"要不要先译英"从插件那里读出来:同一个地址下不同工作流
     吃不吃中文是不一样的,让用户自己猜并不合理(2026-09-26 用户要求)。
     老插件没有这个字段,`englishOnly` 是 null,那就原样保留用户的手工设置。 */
  function applyDiscovery(result) {
    if (typeof result.englishOnly !== "boolean") return "";
    if (draft.needsEnglish === result.englishOnly) return "";
    draft.needsEnglish = result.englishOnly;
    return result.englishOnly
      ? t("这个任务的编码器只认英文,已自动开启「翻译为英文」", "This task reads English only, so translate-to-English was switched on")
      : t("这个任务的编码器能读中文,已自动关掉「翻译为英文」", "This task reads Chinese, so translate-to-English was switched off");
  }

  async function testModel(content) {
    var status = content.querySelector("[data-test-status]");
    readForm(content);
    status.textContent = t("连接中,不生成图片…", "Connecting without generating an image…");
    status.classList.remove("is-error");
    try {
      var result = await app.services.providers.test(draft);
      if (result && result.task) {
        var notes = [t("连接成功", "Connected")];
        if (result.version) notes.push(t("插件", "plugin") + " " + result.version);
        notes.push(t("当前模型", "model") + " " + result.model);
        var applied = applyDiscovery(result);
        if (applied) { notes.push(applied); ui().toast(applied); }
        status.textContent = notes.join(" · ") + "。";
      } else {
        status.textContent = t("连接成功;出图能力取决于所选模型。", "Connected. Image support depends on the selected model.");
      }
    } catch (error) {
      status.textContent = t("连接失败:", "Connection failed: ") + app.utils.cleanError(error);
      status.classList.add("is-error");
      throw error;
    }
  }

  async function saveModel() {
    var content = document.getElementById("modal-content");
    readForm(content);
    app.services.providers.validate(draft);
    var config = app.utils.copy(app.config);
    /* CVP 的地址/密码/请求头**唯一出处是 config.connection**(store.shareCvp 会把它分发到
       每一张 cvp 卡)。表单填的只能落在 shared() 上,所以这里必须显式回写 ——
       少了这一步,shareCvp 紧接着就拿旧的空 connection 把所有 cvp 卡的地址覆盖成空,
       表现就是"填好地址一保存又变空"。 */
    if (draft.protocol === "cvp") config.connection = app.utils.copy(shared());
    var position = -1;
    config.models.forEach(function (item, order) { if (item.id === draft.id) position = order; });
    if (position >= 0) config.models[position] = app.utils.copy(draft);
    else config.models.push(app.utils.copy(draft));
    await app.services.store.saveConfig(config);
    ui().closeSheet();
    ui().toast(position >= 0 ? t("模型卡已更新", "Model card updated") : t("模型卡已添加", "Model card added"));
    app.events.emit("config:changed", {});
  }

  /* ---------- 模型设置 ---------- */

  function modelCardHtml(item, activeId) {
    var isActive = item.id === activeId;
    var protocol = app.services.providers.protocols.filter(function (entry) { return entry.id === item.protocol; })[0];
    return '<article class="model-card' + (isActive ? " is-active" : "") + '" data-model="' + esc(item.id) + '">' +
      '<button class="model-pick" data-activate="' + esc(item.id) + '" type="button">' +
      '<span class="model-line"><strong>' + esc(item.name) + "</strong>" +
      (isActive ? '<span class="model-active">' + t("使用中", "In use") + "</span>" : "") + "</span>" +
      '<span class="model-sub">' + esc(protocol ? protocol.name : item.protocol) + " · " + item.size + "px · " +
      t("强度", "Strength") + " " + item.refStrength + "</span>" +
      '<span class="model-sub">' + esc(item.endpoint || t("还没有填地址", "No address yet")) + "</span></button>" +
      /* 译英开关(2026-09-25 用户要求)。它挂在**卡**上而不是全局:同一个地址下
         不同工作流吃不吃中文是不一样的,全局开关只能二选一。
         2026-09-26 起这个值由插件自报(卡上点「测试连接」时会自动写一次)——
         开关留着是为了给用户一个手工覆盖的入口,不再是必须自己猜的项。 */
      '<div class="switch-row"><span class="switch-text"><strong>' + t("需要翻译为英文", "Translate to English") +
      "</strong><small>" + t("用这张卡生图时,中文角色描述会先译成英文。点「测试连接」会按插件自报的结果自动设置,也可以在这里手工改",
        "When generating with this card, a Chinese description is translated first. Test connection sets this from what the plugin reports; you can still change it here") +
      '</small></span><label class="switch"><input type="checkbox" data-needs-english="' + esc(item.id) + '"' +
      (item.needsEnglish === true ? " checked" : "") + '><span class="switch-track"></span><span class="switch-thumb"></span></label></div>' +
      '<div class="model-actions"><button class="button button-secondary" data-edit="' + esc(item.id) + '" type="button">' +
      t("编辑", "Edit") + '</button><button class="icon-button" data-remove="' + esc(item.id) + '" type="button" aria-label="' +
      t("删除模型卡", "Delete card") + '"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></div></article>';
  }

  /* back:"generate" 表示这一层是从生成弹窗点进来的 —— 关掉时要把生成弹窗摆回去。
     重画(点卡激活、删卡)时不会再传 options,所以 back 要记住上一次的值。
     从菜单进来的必须显式传 back:"" 把它清掉,否则上一条链的回退会跟过来。 */
  var modelsBack = "";

  function openModels(options) {
    if (options && options.back !== undefined) modelsBack = String(options.back || "");
    var list = app.config.models || [];
    var html = '<p class="field-help">' + t("点一张卡就用它生图。", "Tap a card to generate with it.") + "</p>" +
      (list.length ? '<div class="model-list">' + list.map(function (item) { return modelCardHtml(item, app.config.activeModelId); }).join("") + "</div>"
        : '<p class="sheet-note">' + t("还没有模型卡。", "No model cards yet.") + "</p>") +
      '<div class="form-actions"><button class="button button-primary" type="button" data-add><i class="fa-solid fa-plus" aria-hidden="true"></i>' +
      t("添加模型", "Add model") + "</button></div>";

    ui().openSheet({
      eyebrow: t("生成", "Generation"),
      title: t("模型列表", "Model list"),
      bodyHtml: html,
      onClose: modelsBack === "generate" ? function () { app.features.editor.openGenerateSheet(); } : null,
      onMount: function (content) {
        var add = content.querySelector("[data-add]");
        if (add) add.onclick = function () { openAddModel("models"); };
        Array.prototype.forEach.call(content.querySelectorAll("[data-activate]"), function (button) {
          button.onclick = ui().action(async function () {
            var config = app.utils.copy(app.config);
            config.activeModelId = button.dataset.activate;
            await app.services.store.saveConfig(config);
            openModels();
            ui().toast(t("已切换生图模型", "Generation model switched"));
          });
        });
        Array.prototype.forEach.call(content.querySelectorAll("[data-edit]"), function (button) {
          button.onclick = function () { openModelForm(button.dataset.edit, "models"); };
        });
        /* 译英开关:就地存,不整页重画 —— 重画会把用户刚拨的那一下连焦点一起冲掉。
           文案随开关状态说清"以后会怎样",因为这一下改的是生图的输入。 */
        Array.prototype.forEach.call(content.querySelectorAll("[data-needs-english]"), function (input) {
          input.onchange = ui().action(async function () {
            var id = input.dataset.needsEnglish;
            var config = app.utils.copy(app.config);
            config.models.forEach(function (item) { if (item.id === id) item.needsEnglish = input.checked === true; });
            await app.services.store.saveConfig(config);
            ui().toast(input.checked
              ? t("这张卡生图前会先把中文描述译成英文", "This card will translate a Chinese description first")
              : t("这张卡直接按原文生图", "This card will submit the text as-is"));
          });
        });
        Array.prototype.forEach.call(content.querySelectorAll("[data-remove]"), function (button) {
          button.onclick = ui().action(async function () {
            var id = button.dataset.remove;
            var confirmed = await ui().confirm({
              title: t("删除这张模型卡?", "Delete this model card?"),
              message: t("只删配置,不影响服务端。", "Only the local config is removed; the server is untouched."),
              okText: t("删除", "Delete")
            });
            if (!confirmed) return;
            var config = app.utils.copy(app.config);
            config.models = config.models.filter(function (item) { return item.id !== id; });
            if (config.activeModelId === id) config.activeModelId = config.models.length ? config.models[0].id : "";
            await app.services.store.saveConfig(config);
            openModels();
            ui().toast(t("模型卡已删除", "Model card deleted"));
          });
        });
      }
    });
  }

  /* ---------- 软件设置 ---------- */

  /* 横向三格 tab 组(2026-09-25 用户要求:「语言使用横向 3 个 tab 按钮组」)。
     语言只有三个取值,竖着排三行占掉半屏,横过来一格一个才是这个控件该有的样子。 */
  function tabRow(name, entries, current) {
    return '<div class="tab-row" role="tablist">' + entries.map(function (entry) {
      return '<button type="button" role="tab" class="tab-button' + (entry[0] === current ? " is-on" : "") +
        '" data-' + name + '="' + esc(entry[0]) + '" aria-selected="' + (entry[0] === current ? "true" : "false") + '">' +
        esc(entry[1]) + "</button>";
    }).join("") + "</div>";
  }

  /* 只有中文界面才需要"中英翻译"这一项 —— 英文界面的人本来就在写英文,
     给他一个中文提示词译成英文的模型,除了困惑没有别的用处。 */
  function wantsTranslate() { return app.i18n.language() === "zh"; }

  function translateProtocol() {
    var table = app.services.translate.protocols || {};
    var id = String((app.config.translate || {}).protocol || "cvp");
    return Object.prototype.hasOwnProperty.call(table, id) ? id : "cvp";
  }

  /* 只有 CVP 才借生图那套地址 —— 那是插件的地址。别的协议借不来,必须自己填。 */
  function translateEndpoint() {
    var translate = app.config.translate || {};
    if (String(translate.endpoint || "")) return String(translate.endpoint);
    return translateProtocol() === "cvp" ? String(app.config.connection.endpoint || "") : "";
  }

  function translateRowHtml() {
    var translate = app.config.translate || {};
    var table = app.services.translate.protocols || {};
    var protocol = table[translateProtocol()] || {};
    var endpoint = translateEndpoint();
    var state = !endpoint ? t("还没有添加", "Not added yet")
      : (translate.enabled ? t("已启用", "Enabled") : t("已填写但没有测试通过", "Filled in but never passed the test"));
    var detail = translateProtocol() === "cvp"
      ? (endpoint || t("用插件自带的大模型把中文描述译成英文", "Uses the plugin's own model to turn Chinese into English"))
      : t(protocol.zh || "", protocol.en || "") + " · " + (String(translate.model || "") || t("未填模型", "no model yet"));
    return '<div class="section-label">' + t("中英翻译", "Chinese to English") + "</div>" +
      '<div class="translate-card"><div class="translate-info"><strong>' + esc(state) + "</strong>" +
      "<small>" + esc(detail) + "</small></div>" +
      '<button class="button ' + (translate.enabled ? "button-secondary" : "button-primary") + '" type="button" data-translate-model>' +
      (translate.enabled ? t("修改", "Change") : t("添加中英文翻译模型", "Add translation model")) + "</button></div>" +
      '<p class="field-help">' + t("标了「需要翻译为英文」的模型卡,生图前会先用它把中文描述译成英文,译文只翻一次、存在本机。",
        "Cards marked Translate to English use it to turn a Chinese description into English before generating. Each sentence is translated once and cached on this device.") + "</p>";
  }

  /* back:"generate" = 这一层是被生成弹窗里的"去配置翻译"送过来的,关掉要把它摆回去 */
  function openPreferences(options) {
    var languages = [["system", t("跟随系统", "System")], ["zh", "简体中文"], ["en", "English"]];
    var current = app.i18n.preferred();
    var html = '<div class="section-label">' + t("语言", "Language") + '</div>' +
      tabRow("language", languages, current) +
      '<p class="field-help">' + t("界面主题固定为深色,不提供切换。语言设置保存在本设备。", "The theme is fixed to dark and cannot be switched. The language setting is saved on this device.") + "</p>" +
      (wantsTranslate() ? translateRowHtml() : "");

    ui().openSheet({
      eyebrow: t("偏好", "Preferences"),
      title: t("软件设置", "Preferences"),
      bodyHtml: html,
      onClose: options && options.back === "generate"
        ? function () { app.features.editor.openGenerateSheet(); } : null,
      onMount: function (content) {
        Array.prototype.forEach.call(content.querySelectorAll("[data-language]"), function (button) {
          button.onclick = ui().action(async function () {
            var config = app.utils.copy(app.config);
            config.preferences.language = button.dataset.language;
            await app.services.store.saveConfig(config);
            app.i18n.setLanguage(button.dataset.language);
            app.i18n.apply();
            ui().closeSheet();
            ui().toast(t("界面语言已更新", "Language updated"));
          });
        });
        var translateButton = content.querySelector("[data-translate-model]");
        if (translateButton) translateButton.onclick = openTranslateForm;
      }
    });
  }

  /* ---------- 添加中英文翻译模型 ----------
   * 接口格式支持 CVP 插件与 DeepSeek / Qwen / OpenAI / Claude / Gemini
   * (2026-09-26 用户要求)。前三家都是 OpenAI 兼容的 /chat/completions,所以归成一项,
   * 下拉里点名它们 —— 让用户先选"OpenAI 兼容"再选一次"DeepSeek"是多余的一步。
   * 保存与测试合成一步:用户的话是「添加成功并测试成功之后」才生效,
   * 那就别给他一个"存了但其实不能用"的中间状态。 */

  function openTranslateForm() {
    var translate = app.config.translate || {};
    var table = app.services.translate.protocols || {};
    var protocol = translateProtocol();
    var endpoint = translateEndpoint();
    var apiKey = String(translate.apiKey || (!translate.endpoint ? app.config.connection.apiKey || "" : ""));
    var headers = String(translate.customHeaders || (!translate.endpoint ? app.config.connection.customHeaders || "" : ""));
    var entries = Object.keys(table).map(function (id) { return [id, t(table[id].zh, table[id].en)]; });
    var html = '<div class="field"><span>' + t("接口模式", "API format") + "</span>" +
      selectRow("protocol", entries, protocol) +
      '<p class="field-help" data-translate-help></p></div>' +
      field("endpoint", t("服务器地址", "Server address"), endpoint, "url", "") +
      '<label class="field"><span>' + t("访问密码 / API Key", "Access password / API key") + "</span>" +
      '<div class="secret-input"><input name="apiKey" type="password" autocomplete="off" value="' + esc(apiKey) + '" placeholder="' +
      esc(t("服务商给的那串;本地服务没启用密码就留空", "The one your provider gave you; leave empty for a local service without a password")) +
      '"><button type="button" data-toggle-secret aria-label="' + t("显示密钥", "Show key") + '"><i class="fa-regular fa-eye" aria-hidden="true"></i></button>' +
      '<button type="button" data-paste-secret aria-label="' + t("粘贴密钥", "Paste key") + '"><i class="fa-regular fa-paste" aria-hidden="true"></i></button></div></label>' +
      '<label class="field" data-model-field><span>' + t("模型 ID", "Model ID") + "</span>" +
      '<input name="model" type="text" value="' + esc(translate.model || "") + '" placeholder=""></label>' +
      /* 自定义请求头只有极少数人才用得到,按要求折进「高级设定」并默认收起 */
      '<details class="advanced"><summary>' + t("高级设定", "Advanced") + "</summary>" +
      '<label class="field"><span>' + t("自定义请求头 JSON", "Custom headers JSON") +
      '</span><textarea name="customHeaders" rows="2" placeholder="{&quot;X-API-Key&quot;:&quot;your-key&quot;}">' + esc(headers) + "</textarea></label></details>" +
      '<div class="form-actions"><button class="button button-primary" type="button" data-test-translate><i class="fa-solid fa-language" aria-hidden="true"></i>' +
      t("测试并保存", "Test and save") + '</button><button class="button button-secondary" type="button" data-translate-off' +
      (translate.enabled ? "" : ' hidden') + '>' + t("停用", "Turn off") + "</button></div>" +
      '<p class="connection-status" data-translate-status></p>' +
      '<p class="field-help">' + t("测试会发一句「一只蓝色的水晶鸟」给这个地址,看到英文译文才算通过。",
        "The test sends a Chinese sentence to this address; it passes only when an English translation comes back.") + "</p>";

    ui().openSheet({
      eyebrow: t("偏好", "Preferences"),
      title: t("添加中英文翻译模型", "Add translation model"),
      bodyHtml: html,
      onMount: function (content) {
        var status = content.querySelector("[data-translate-status]");
        var secretInput = content.querySelector('[name="apiKey"]');
        var endpointInput = content.querySelector('[name="endpoint"]');
        var modelInput = content.querySelector('[name="model"]');
        var modelField = content.querySelector("[data-model-field]");
        var help = content.querySelector("[data-translate-help]");
        var picker = content.querySelector('[name="protocol"]');

        /* 说明与占位随协议走。**不重建表单** —— 重建会把用户刚敲进去的地址和密钥
           一起冲掉,而这个下拉是允许边填边改的。 */
        function paint() {
          var item = table[protocol] || {};
          if (help) help.textContent = t(item.zhHelp || "", item.enHelp || "");
          if (endpointInput) endpointInput.placeholder = item.endpoint || "";
          if (modelInput) modelInput.placeholder = item.model || "";
          if (modelField) modelField.hidden = protocol === "cvp";
        }
        paint();

        if (picker) picker.onchange = function () {
          var previous = (table[protocol] || {}).endpoint || "";
          var next = Object.prototype.hasOwnProperty.call(table, picker.value) ? picker.value : "cvp";
          /* 地址还停在上一档的默认值(或空着)就跟着换掉;用户自己填过的不覆盖 */
          var current = endpointInput ? endpointInput.value.trim() : "";
          if (endpointInput && (!current || current === previous)) endpointInput.value = (table[next] || {}).endpoint || "";
          protocol = next;
          status.textContent = "";
          status.classList.remove("is-error");
          paint();
        };

        var toggle = content.querySelector("[data-toggle-secret]");
        if (toggle) toggle.onclick = function () {
          var reveal = secretInput.type === "password";
          secretInput.type = reveal ? "text" : "password";
          toggle.setAttribute("aria-label", reveal ? t("隐藏密钥", "Hide key") : t("显示密钥", "Show key"));
          toggle.innerHTML = '<i class="fa-regular fa-' + (reveal ? "eye-slash" : "eye") + '" aria-hidden="true"></i>';
        };
        var paste = content.querySelector("[data-paste-secret]");
        if (paste) paste.onclick = ui().action(async function () {
          secretInput.value = String(await app.platform.hermit.clipboardRead()).trim();
        });

        content.querySelector("[data-test-translate]").onclick = ui().action(async function () {
          var candidate = {
            protocol: protocol,
            endpoint: endpointInput.value.trim(),
            apiKey: secretInput.value,
            model: modelInput ? modelInput.value.trim() : "",
            customHeaders: content.querySelector('[name="customHeaders"]').value
          };
          status.classList.remove("is-error");
          if (!candidate.endpoint) {
            status.textContent = t("请先填写翻译服务地址", "Enter the translation endpoint first");
            status.classList.add("is-error");
            return;
          }
          if (candidate.protocol !== "cvp" && !candidate.model) {
            status.textContent = t("请填写模型 ID", "Enter the model id");
            status.classList.add("is-error");
            return;
          }
          status.textContent = t("正在测试翻译…", "Testing the translation…");
          try {
            var result = await app.services.translate.probe(candidate);
            var config = app.utils.copy(app.config);
            config.translate = {
              enabled: true, protocol: candidate.protocol, endpoint: candidate.endpoint,
              apiKey: candidate.apiKey, model: candidate.model, customHeaders: candidate.customHeaders
            };
            await app.services.store.saveConfig(config);
            status.textContent = t("翻译可用:" + (result.engine ? result.engine + " · " : "") + result.example + " → " + result.text,
              "Translation ready: " + (result.engine ? result.engine + " · " : "") + result.example + " → " + result.text);
            ui().toast(t("中英翻译已启用", "Translation enabled"));
            ui().closeSheet();
          } catch (error) {
            status.textContent = t("测试失败:", "Test failed: ") + app.utils.cleanError(error);
            status.classList.add("is-error");
            throw error;
          }
        });

        var off = content.querySelector("[data-translate-off]");
        if (off) off.onclick = ui().action(async function () {
          var config = app.utils.copy(app.config);
          config.translate = app.utils.merge(config.translate, { enabled: false });
          await app.services.store.saveConfig(config);
          ui().closeSheet();
          ui().toast(t("中英翻译已停用", "Translation turned off"));
        });
      }
    });
  }

  /* ---------- 使用说明 ---------- */

  function helpLine(icon, title, detail) {
    return '<div class="help-line"><span class="help-icon" aria-hidden="true">' + icon + "</span><div><strong>" + title + "</strong><p>" + detail + "</p></div></div>";
  }
  function helpSection(title, rows) { return "<h3>" + title + '</h3><div class="help-list">' + rows.join("") + "</div>"; }
  function fa(style, name) { return '<i class="' + style + ' fa-' + name + '" aria-hidden="true"></i>'; }

  function openHelp() {
    var body = '<div class="help-copy">' +
      helpSection(t("摆姿", "Posing"), [
        helpLine(fa("fa-solid", "person"), t("① 套一个预设开始", "1 · Start from a preset"),
          t("底部「姿态」里是整套造型:站、T 字、行走、举手、坐下。套用会覆盖当前姿态。", "The Pose button holds whole figures: stand, T pose, walk, wave, sit. Applying one replaces the current pose.")),
        helpLine(fa("fa-solid", "sliders"), t("② 拖关节微调", "2 · Fine-tune joints"),
          t("点人物身上的连接杆绕该关节旋转,点节点球把它挪到手指的位置。头部没有球 —— 直接抓头就是移动它。", "Tap a limb to rotate around that joint, tap a joint ball to drag it under your finger. The head has no ball: grab the head itself to move it.")),
        helpLine(fa("fa-solid", "hand-pointer"), t("③ 选取面板", "3 · Joint picker"),
          t("「选取」里可以按名字选关节,并用上一个 / 下一个 / 对面在骨架里走:上一个到父关节,下一个到子关节,对面到左右对称的那一个。", "The Pick panel selects joints by name and walks the skeleton with Back / Next / Mirror: Back goes to the parent, Next to a child, Mirror to the left-right twin.")),
        helpLine(fa("fa-solid", "arrows-rotate"), t("④ 自转滑杆", "4 · Twist slider"),
          t("选出可自转的关节时,底部浮出一条滑杆。自转是拖拽碰不到的自由度(转轴就是骨头自己),只能用滑杆调。", "When the selected joint can twist, a slider appears above the buttons. Dragging can never reach that axis, so the slider is the only way."))
      ]) +
      helpSection(t("视图与工具", "View and tools"), [
        helpLine(fa("fa-solid", "camera"), t("转视角", "Orbit the view"),
          t("在空白处拖动转视角,双指捏合放缩,双指拖动平移,双击空白让整个人回到画面正中。", "Drag the background to orbit, pinch to zoom, two-finger drag to pan, double-tap the background to bring the figure back to the centre.")),
        helpLine(fa("fa-solid", "screwdriver-wrench"), t("工具", "Tools"),
          t("「工具」里三件事:搬运(拖着整人走,姿态不变)、左右镜像(左右姿势整体翻转)、相机归位。", "Tools holds three things: Move (drag the whole figure without changing the pose), Mirror (flip the pose left to right), and Reset view.")),
        helpLine(fa("fa-solid", "palette"), t("渲染", "Render"),
          t("「渲染」是给模型看的检查层:无 / 正反黑白 / 正反红绿。开了之后正面与背面用不同颜色区分,方便确认朝向对不对。它只改变显示,不改变姿态,也不会进成图。", "Render is a check layer for the model: off, front-back grey, front-back red-green. It tints the two sides differently so you can confirm the facing. It only changes the display — never the pose, never the generated image."))
      ]) +
      helpSection(t("出图", "Generation"), [
        helpLine(fa("fa-solid", "wand-magic-sparkles"), t("生成", "Generate"),
          t("先写一句画面描述,再点生成。PoseGi 会把当前姿态渲染成 1024 的参考图,连同描述与参考图强度一起交给模型。", "Write a description, then generate. PoseGi renders the current pose into a 1024 reference and hands it to the model together with the description and the reference strength.")),
        helpLine(fa("fa-solid", "images"), t("历史成图", "History"),
          t("生成弹窗里是当前作品最近 12 张成图,点一张可以全屏查看、放大拖动,并在那里直接删除。超过 12 张时最旧的会被顶掉。", "The generation sheet shows the last 12 images of this artwork. Tap one to view it fullscreen, zoom and pan, and delete it right there. Past 12, the oldest drops off.")),
        helpLine(fa("fa-solid", "ban"), t("取消", "Cancel"),
          t("生成过程中可以关掉弹窗,也可以点取消。取消只是不再等这一次的结果,服务端任务可能仍在跑。", "You can close the sheet or cancel while generating. Cancel stops waiting for this result; the server job may still be running."))
      ]) +
      helpSection(t("模型", "Models"), [
        helpLine(fa("fa-solid", "cubes"), t("接上自己的模型", "Connect a model"),
          t("「添加模型」里选接口模式。推荐在本地 ComfyUI 装 VibeDraw 插件(CVP):插件自带快速生图与渲染两套工作流,密码在插件的配置节点里设置。", "Pick an API format under Add model. Installing the VibeDraw plugin (CVP) on a local ComfyUI is recommended: it ships the quick and render workflows, and its password lives in the plugin's config node.")),
        helpLine(fa("fa-solid", "sliders"), t("分辨率与参考图强度", "Size and reference strength"),
          t("每张卡有自己的生成分辨率(512–1024)与参考图强度(0–200,100 为中性)。强度调高更贴渲染图,调低给模型更多自由。", "Each card has its own output size (512–1024) and reference strength (0–200, 100 neutral). Higher sticks closer to the render; lower frees the model.")),
        helpLine(fa("fa-solid", "circle-check"), t("切换与测试", "Switch and test"),
          t("「模型设置」里点一张卡就用它生图;每张卡上都有测试连接,不生成图片也能确认地址与密码对不对。", "In Models, tap a card to generate with it. Every card has a connection test that validates the address and password without generating anything."))
      ]) +
      helpSection(t("作品", "Artworks"), [
        helpLine(fa("fa-solid", "folder-open"), t("作品库", "Your artworks"),
          t("一件作品 = 标题 + 画面描述 + 属于它的成图。新建时写一句描述即可开始,之后随时能打开继续生成。", "An artwork is a title, a description, and its own images. Create one with a description and keep generating; reopen it any time.")),
        helpLine(fa("fa-regular", "trash-can"), t("删除", "Delete"),
          t("删除作品会连它的成图一起删除,不能恢复。", "Deleting an artwork also deletes its images. This cannot be undone."))
      ]) + "</div>";
    ui().openSheet({ eyebrow: t("说明", "Guide"), title: t("使用说明", "How to use PoseGi"), bodyHtml: body });
  }

  /* ---------- 软件信息 ---------- */

  function openAbout() {
    var html = '<div class="about-brand"><img class="brand-mark" src="./app/assets/icon.webp" alt="" width="38" height="38"><div><strong>PoseGi</strong>' +
      '<div class="about-meta">v' + esc(app.version) + " · MIT</div></div></div>" +
      "<p>" + t("摆好姿势,再交给 AI 完成画面。", "Pose it by hand, then let AI finish the picture.") + "</p>" +
      '<p class="about-meta">' + t("原生 HTML / CSS / JavaScript 开源 happ,运行在 Hermit 上。姿态在本机渲染,只有你配置的服务会收到画面。",
        "An open-source HTML / CSS / JavaScript happ running on Hermit. The pose renders on this device; only the service you configured receives the image.") + "</p>" +
      '<a class="button button-secondary about-link" href="' + PROJECT_URL + '" target="_self">' + fa("fa-brands", "github") +
      t("GitHub 仓库", "GitHub repository") + "</a>" +
      '<p class="about-meta">© 2026 zhyuzh · Font Awesome Free (Hermit)</p>';
    ui().openSheet({ eyebrow: t("关于", "About"), title: "PoseGi " + app.version, bodyHtml: html });
  }

  app.components.settings = {
    init: init,
    openAddModel: openAddModel,
    openModels: openModels,
    openPreferences: openPreferences,
    openHelp: openHelp,
    openAbout: openAbout
  };
})(window.posegi);
