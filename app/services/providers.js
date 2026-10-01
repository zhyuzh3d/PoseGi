/* 生图接口适配:把统一请求翻译成各家本地服务的协议
 *
 * 责任:只做协议翻译,不做编排、不读 app.state。
 * 等待期间的**只读**请求(轮询 / 读作业 / 取图)带有限重试 —— 见 chpReadQuiet;
 * 提交(POST)绝不重试,那会在服务端多出一个作业。
 * 约定:每个协议实现 generate(config, input) → { src, logicalFileId?, metadata }
 *
 * config(模型卡,见 app.defaults.models)关键字段:
 *   protocol  "chp" | "openai-images" | "sd-webui" | "stability"
 *   endpoint  服务器地址;apiKey 访问密码 / API Key
 *   resolution 生成分辨率,形式 "_WxH_"(**宽高比锁死 9:16**,见 app.defaults.ratio)
 *             **chp 卡上它只是"上次挑的那条"**,真值由插件的帧表说了算
 *             (见 chpResolution —— 只挑帧表里标着 `9:16` 的那一档)
 *   refStrength 参考图强度(0–200,100 为中性) → 只对 chp 生效,见 refStrength01
 *   timeoutMs / customHeaders / task(仅 chp;task 的取值就是插件的 category)
 *
 * 关于 `steps`(2026-10-01):**步数一个字节都不发**。`chp/2` 要求客户端报的只有
 * seed 与画幅两样,其余旋钮都属于部署侧(插件那台机器自己的加速档案 / 工作流默认值)。
 * 本应用的步数本来就没有控件(见 settings 的 chpFrameField),发出去只会把一台配好
 * 加速的机器按回默认步数上 —— 加速档案**只在自己那一档步数上生效**,于是"配置好了"
 * 与"实际在跑"会悄悄分家。卡里那一栏只当"还没读过插件文档"时的兜底。
 *
 * input(由 image-engine 组装):
 *   { prompt, negativePrompt, seed, imageDataUrl, mime }
 *   imageDataUrl 永远是 9:16、高度 1024 的渲染参考图(见 app.defaults.reference);
 *   但**要不要附**由插件那条规则说了算:带 `ref` 的规则才附(见 chpTakesImage)。
 *
 * 选型说明(照抄 hamdraw 已经跑通的那一套):
 *   - chp(ComfyUI Haminn Protocol)是推荐路径:插件自带工作流,客户端只报场景名 +
 *     画幅 + 参考图,而且成图由插件自己发,提交与取图共用一把密码。
 *   - sd-webui 最省事:一次 POST /sdapi/v1/img2img,参考图直接放 init_images。
 *   - openai-images 走 /v1/images/edits(multipart),纯文字走 /v1/images/generations。
 *   - stability 走 v2beta 的 control/sketch(图)与 generate/core(文)。
 */
(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.haminn;

  function t(zh, en) { return app.i18n ? app.i18n.text(zh, en) : zh; }

  var PROTOCOLS = [
    { id: "chp", name: "CHP 插件（ComfyUI Haminn Protocol，推荐）",
      description: "连接装有 CHP 插件的 ComfyUI。插件自带快速生图 / 图像放大 / 高质量生图几套工作流,不需要导出工作流 JSON;访问密码在插件的配置节点里设置。中文提示词由插件自己译成英文。" },
    { id: "openai-images", name: "OpenAI Images 兼容",
      description: "兼容 /v1/images/generations 与 /v1/images/edits,适合云端与兼容网关。" },
    { id: "sd-webui", name: "SD WebUI / Forge",
      description: "兼容 /sdapi/v1/img2img,适合局域网 Stable Diffusion WebUI 或 Forge。" },
    { id: "stability", name: "Stability AI",
      description: "兼容 Stable Image v2beta 的 Control Sketch 与 Generate 接口。" }
  ];

  /* ---------- CHP 的任务 ----------
   *
   * 插件自带工作流,客户端只报一个**场景名** —— 卡上那一栏(task)从 chp/2 起就是
   * 插件自己的词:`fast` / `upscale` / `render`,和请求体里的 `category` 一模一样。
   * 出厂参数(出厂画幅、步数、参考图基准、超时)来自 app.defaults.chpTasks。
   *
   * 为什么要把它做成同一套词:`chp/2` 取消了别名机制,插件对不认识的场景名只会回
   * `unsupported_category`。两套词之间每多一层换算,就多一处能悄悄发错名字的地方 ——
   * 而这个名字从 `qwen`(卡的词)到 `render`(插件的词)那一次,正是插件升级后
   * 最先坏掉的地方。 */
  function chpSpec(task) { return app.defaults.chpTasks[task] || app.defaults.chpTasks.fast; }

  /* 场景名合法吗。**判据不是一个写死的名单**:
     `chp/2` 的 `rules[]` 就是这个名单本身,客户端按需读、读不到才用自己那份
     (见 chp-v2-plan §1.2)。所以出厂表里有、或插件刚刚播报过,都算合法。
     只认出厂表的话,插件加一个场景就会被这里悄悄改成 fast ——
     卡上写着那个场景、发出去的却是快速绘制的路线。 */
  function chpKnown(task) {
    var value = String(task == null ? "" : task);
    if (!value) return false;
    if (Object.prototype.hasOwnProperty.call(app.defaults.chpTasks, value)) return true;
    return Boolean(chpRule(value));
  }
  function chpTask(config) {
    var value = String(config && config.task || "");
    return chpKnown(value) ? value : "fast";
  }

  /* 界面上的场景清单。**顺序就是插件的顺序** —— 它播报出来的次序就是它想让人看到的
     次序,本应用不重排。
     本应用做不来的场景不列:`mask: true` 的(局部重绘)要一张蒙版,而这里只有"整张
     重画"这一条路。判据同样来自插件自报的 `needs`,不是一张写死的名单 ——
     插件将来加一个不需要蒙版的新场景,它自己就会出现在界面上。
     没读过插件文档时(没点过「测试连接」)退到出厂表:界面总得有东西显示。 */
  function chpCategories() {
    var list = ((chpDocument && chpDocument.rules) || []).filter(function (rule) {
      if (!rule || !String(rule.category || "").trim()) return false;
      return !(rule.needs && rule.needs.mask === true);
    }).map(function (rule) { return String(rule.category).trim(); });
    return list.length ? list : Object.keys(app.defaults.chpTasks);
  }

  /* 插件给的名字与说明:`label` / `description` 各是一对 { zh, en }。
     它不是规范键(规范只认 `category` 与 `rule`),所以**读不到就用本应用自己那份** ——
     这正是"作者换了说法,界面跟着变"与"插件没给,界面也有话说"能同时成立的原因。 */
  function chpText(value) {
    if (!value || typeof value !== "object") return "";
    return String(app.i18n.language() === "en" ? value.en : value.zh || "").trim();
  }

  function taskName(task) {
    var rule = chpRule(task), named = chpText(rule && rule.label);
    if (named) return named;
    if (task === "upscale") return t("图像放大", "Upscale");
    if (task === "render") return t("高质量生图", "High-quality render");
    if (task === "generate") return t("纯文生图", "Text to image");
    return t("快速生图", "Quick draw");
  }
  /* 请求里报的那个场景名,用在进度提示上 */
  function taskLabel(task) { return taskName(task); }

  /* 场景自己那句话(界面里任务按钮下面那一段)。插件的优先,没给就用本应用那份。 */
  function taskDescription(task) {
    var rule = chpRule(task), said = chpText(rule && rule.description);
    if (said) return said;
    if (task === "upscale") return t("把当前的 1024 渲染图放大并补细节,构图基本不动。", "Upscales the current 1024 render and adds detail; the composition stays put.");
    if (task === "render") return t("按参考图重新作画,是这里最重、也最像成片的一档;单张几十秒,中文提示词它也照画。", "Repaints from the reference. The heaviest task here and the one that looks most like a finished photo; tens of seconds per image, and it reads Chinese too.");
    if (task === "generate") return t("只按提示词画,不附参考图 —— 没有定妆照时走这一档。", "Draws from the prompt alone, with no reference: the path to take when there is no portrait to work from.");
    return t("最快的草图路线,一两秒出图,适合先看构图;它能出哪几档画幅由下面那份帧表决定。",
      "The fastest sketch path: a second or two, good for checking the composition. Which canvases it offers comes from the frame table below.");
  }

  function headers(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    if (config.apiKey && !output.Authorization && !output.authorization) output.Authorization = "Bearer " + config.apiKey;
    return output;
  }

  /* 带 body 的 CHP 请求用的头:**故意不带 Authorization**。
     契约要求一个请求只用一种密码载体 —— 有 body 的走 `chp_params.password`,
     只有 GET(轮询、取状态、取图)才走头,理由是"密码不进 URL 也不进日志"。
     两个都发虽然参考实现照收,但多一处密文就多一处会被记下来的地方。 */
  function chpHeaders(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    return output;
  }

  function ensureOk(response, requestHeaders) {
    if (response.status >= 200 && response.status < 300) return response;
    var payload = u.parseJson(response.bodyText || "", null);
    throw network.httpError(response, payload, requestHeaders || {});
  }

  function dataUrl(mime, base64) { return "data:" + (mime || "image/png") + ";base64," + String(base64 || "").replace(/\s/g, ""); }

  function jsonImage(payload) {
    if (!payload) return null;
    var item = payload.data && payload.data[0] || null;
    if (item && item.b64_json) return { src: dataUrl(payload.output_format === "jpeg" ? "image/jpeg" : payload.output_format === "webp" ? "image/webp" : "image/png", item.b64_json), metadata: payload };
    if (item && item.url) return { remoteUrl: item.url, metadata: payload };
    if (payload.images && payload.images[0]) return { src: dataUrl("image/png", String(payload.images[0]).replace(/^data:image\/[^;]+;base64,/, "")), metadata: payload };
    if (payload.image && payload.image.base64) return { src: dataUrl(payload.image.mime || "image/png", payload.image.base64), metadata: payload };
    if (payload.artifacts && payload.artifacts[0] && payload.artifacts[0].base64) return { src: dataUrl("image/png", payload.artifacts[0].base64), metadata: payload };
    return null;
  }

  async function responseImage(response, requestHeaders) {
    ensureOk(response, requestHeaders);
    if (response.file && response.file.url) return { src: response.file.url, logicalFileId: response.file.logicalFileId || "", metadata: {} };
    if (response.bodyBase64) return { src: dataUrl(u.imageMimeFromHeaders(response.headers), response.bodyBase64), metadata: {} };
    var payload = u.parseJson(response.bodyText || "", null);
    var found = jsonImage(payload);
    if (!found) throw new Error(t("模型已响应,但未找到可显示的图片", "The model responded but returned no displayable image"));
    if (!found.remoteUrl) return found;
    var downloaded = await network.request({ url: found.remoteUrl, method: "GET", timeoutMs: 120000 });
    var converted = await responseImage(downloaded, {});
    converted.metadata = found.metadata;
    return converted;
  }

  /* ---------- 画幅 ----------
   *
   * 宽高比**锁死**(唯一出处 app.defaults.ratio,当前 9:16):没有"用户可以改比例"
   * 这条路,所以要表达的只剩**分辨率**一条 —— 它就是请求里那个 `resolution` 字段
   * (CHP)或 width/height 对(别的接口),形式统一是 `"WxH"` 字符串。
   *
   * 以前这里是"一个正方边长 size",宽高比锁死之后那个概念不成立了:
   * 576×1024 与 1080×1920 都是 9:16,边长说不清是哪一边。 */

  /* 分辨率的**书写形式**,唯一出处。`"768x1344x"` 这种多一截的、`"1024"` 这种少一边的,
     解析出来照样是两个数 —— 所以形状必须先在这儿判定,不能靠"解析得出来"当合法。 */
  var RESOLUTION_FORM = /^\d+x\d+$/;

  function pairOf(value) {
    var parts = String(value == null ? "" : value).split("x");
    return [Number(parts[0]) || 0, Number(parts[1]) || 0];
  }

  /* 比例标签的数值形式:`"9:16"` → 0.5625(宽/高)。 */
  function ratioValue(value) {
    var parts = String(value == null ? "" : value).split(":");
    var width = Number(parts[0]) || 0, height = Number(parts[1]) || 0;
    return width > 0 && height > 0 ? width / height : 0;
  }

  /* 这条分辨率是不是锁定的那个比例。**必须留余量,而且是宽松的余量**
     (2026-09-30 用户定:像素容错放到 5%)。
     为什么不能按"精确相等"判:精确到整数边长的 9:16 只有 576×1024、1080×1920
     那几个,而各家最常用的竖幅档没一个是精确值 —— 768×1344 偏 1.587%,
     是这份清单里偏得最远的一条(容差写 1.5% 时,用户在那一档上一点就会被本应用
     自己的校验拒掉;这条是测试当场抓出来的,不是推出来的)。
     放到 5% 是因为**各个服务商的"竖幅"本来就是各自估的**:480×854、640×1136、
     800×1422 这些偏得都不大,但谁也不保证落在 2% 以内;把门槛卡在 2% 只会让用户
     在某个平台上莫名选不了它自己那张竖幅。
     另一头也不会松到认错:5% 的可接受区间是宽高比 0.5344–0.5906,而 3:5 (0.6) 偏
     6.7%、2:3 偏 18.5%、1:1 偏 78%、4:3 / 16:9 / 21:9 更远 —— 一个都进不来。
     真正把关的是**清单成员校验**(见 validate):比例只负责"这不是一条横的或者方的"。 */
  var RATIO_TOLERANCE = 0.05;
  function ratioMatches(value) {
    /* 形状先过一道:`"768x1344x"` 解析出来也是 768 与 1344,照比例判它会一路绿灯。
         写成"先判形状再看比例",这个函数自己就是完整的 —— 调用方漏判不会漏过去。 */
    if (!RESOLUTION_FORM.test(String(value == null ? "" : value).trim())) return false;
    var pair = pairOf(value), wanted = ratioValue(app.defaults.ratio);
    if (!pair[0] || !pair[1] || !wanted) return false;
    return Math.abs(pair[0] / pair[1] - wanted) / wanted <= RATIO_TOLERANCE;
  }

  /* 别的接口真正会发出去的那条分辨率:卡上存的那条必须在清单里,不在就退回清单
     第一条 —— 清单是唯一出处,用户填不进一个清单外的值。 */
  function resolution(config) {
    var list = app.defaults.resolutions || [];
    var value = String(config && config.resolution || "").trim();
    return list.indexOf(value) >= 0 ? value : String(list[0] || "");
  }

  /* CHP 的画幅。
   *
   * `chp/2` 里画幅**不是算出来的,是插件手写的一张表**:`abilities[].frames[]` 每条是
   * 「比例 → 该比例下的分辨率字符串」。客户端只做一件事 —— 从表里挑一条原样发回去
   * (请求字段就叫 `resolution`)。挑不出来、或者挑了一条表外的,服务端一律
   * `400 unsupported_size`,没有"在约束内自己算一张"这条路(那条路随 `size_domain`
   * 一起删掉了)。
   *
   * 本应用锁 9:16,所以只挑标着 `9:16` 的那些帧 —— **读的是标签,不是把两个数字相除**:
   * `768 × 1344` 那种精确比是 4:7、却叫 `9:16`,键是作者起的类目名,反推必错。
   * 挑到之后原样发那条字符串。
   *
   * 还没读过插件文档时(没点过「测试连接」)没有表可挑,退到出厂表 app.defaults.chpTasks
   * 里那一档;那一档是空的就说明这个场景在插件上还没有 9:16(见 namespace 的注释)。 */
  function chpFrames(task) {
    var wanted = String(task == null ? "" : task).toLowerCase(), frames = [];
    ((chpDocument && chpDocument.abilities) || []).forEach(function (ability) {
      ((ability && ability.frames) || []).forEach(function (frame) {
        if (frame && String(frame.category || "").toLowerCase() === wanted) frames.push(frame);
      });
    });
    return frames;
  }
  /* 这个场景能出的、**比例等于锁定比例**的分辨率字符串,按插件的帧表顺序去重。
     非 9:16 的一律跳过:本应用是竖屏构图,拿一条横的回去只会把渲染图拉变形
     (插件的 `stretched_reference` 拦的正是这件事)。 */
  function chpResolutions(task) {
    var wanted = String(app.defaults.ratio || ""), out = [];
    chpFrames(task).forEach(function (frame) {
      if (String(frame.ratio || "").trim() !== wanted) return;
      ((frame.resolution) || []).forEach(function (value) {
        var text = String(value || "").trim();
        if (text && out.indexOf(text) < 0) out.push(text);
      });
    });
    return out;
  }
  /* 这张卡真正会发出去的那条分辨率。读过插件就按它的帧表挑,没读过就按出厂表。
     卡上存的 `resolution` 只是"上次挑的那条" —— 它还在表里就沿用它(用户的选择),
     不在(插件改了表)就退回表里第一条。两条都没有 ⇒ 空串,调用方要当场说清原因。 */
  function chpResolution(config) {
    var task = chpTask(config);
    var list = chpResolutions(task);
    if (list.length) {
      var stored = String(config && config.resolution || "").trim();
      return list.indexOf(stored) >= 0 ? stored : list[0];
    }
    /* **读过插件文档**时表就是权威:表里没有这个场景的 9:16 档,就是"它现在还出不了
       竖幅",返回空串让调用方当场说清是哪一种缺。
       这时**不许退回出厂值**:出厂值说的是"还没问过插件时按这条发",而这里是插件刚刚
       否认过这一条 —— 发出去只会换来 `400 unsupported_size`,错的却像是本应用算错了。
       (真机上 fast / upscale 就是这种情况:它们只有 1:1 与 4:3、3:4。) */
    if (chpDocument) return "";
    return String(chpSpec(task).resolution || "");
  }
  /* 界面与作品卡上显示的分辨率:**一律取真正会发出去的那个值**,而不是卡上存的那个数。
     存的那个数在 chp 卡上只是"还没读过插件时的出厂值",拿它显示就是让界面替请求说谎。 */
  function resolutionText(config) {
    return config && config.protocol === "chp" ? chpResolution(config) : resolution(config);
  }

  /* ---------- OpenAI Images 兼容 ---------- */

  function openAiRoot(endpoint) {
    var value = u.stripSlash(endpoint);
    return value.replace(/\/images\/(?:generations|edits)$/i, "");
  }

  async function openAiGenerate(config, input) {
    var root = openAiRoot(config.endpoint), useReference = Boolean(input.imageDataUrl);
    var url = root + "/images/" + (useReference ? "edits" : "generations");
    var requestHeaders, response;
    if (useReference) {
      var image = u.dataUrlParts(input.imageDataUrl);
      var fields = {
        model: config.model,
        prompt: input.prompt,
        n: 1,
        size: resolution(config),
        quality: config.quality || (config.task === "upscale" ? "high" : "low"),
        output_format: "png"
      };
      var files = [{ name: "image", filename: "posegi.png", mime: image.mime, bytes: image.bytes }];
      var body = u.multipart(fields, files);
      requestHeaders = headers(config, body.contentType);
      response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    } else {
      requestHeaders = headers(config, "application/json");
      response = await network.request({
        url: url, method: "POST", headers: requestHeaders, timeoutMs: config.timeoutMs,
        bodyText: JSON.stringify({ model: config.model, prompt: input.prompt, n: 1, size: resolution(config), quality: config.quality || "auto", response_format: "b64_json" })
      });
    }
    return responseImage(response, requestHeaders);
  }

  /* ---------- SD WebUI / Forge ---------- */

  async function sdWebuiGenerate(config, input) {
    var url = u.stripSlash(config.endpoint) + "/sdapi/v1/" + (input.imageDataUrl ? "img2img" : "txt2img");
    var requestHeaders = headers(config, "application/json");
    var pair = pairOf(resolution(config));
    var body = {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      width: pair[0],
      height: pair[1],
      steps: Number(config.steps) || (config.task === "upscale" ? 28 : 6),
      seed: Number(input.seed),
      cfg_scale: config.task === "upscale" ? 6 : 2,
      batch_size: 1,
      n_iter: 1,
      send_images: true,
      save_images: false
    };
    if (input.imageDataUrl) {
      body.init_images = [u.dataUrlParts(input.imageDataUrl).base64];
      body.denoising_strength = u.clamp(Number(refStrength01(config)), 0, 1);
      body.resize_mode = 0;
    }
    if (config.model) body.override_settings = { sd_model_checkpoint: config.model };
    var response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }

  /* ---------- Stability AI ---------- */

  function stabilityEndpoint(config) {
    var endpoint = u.stripSlash(config.endpoint);
    if (/\/v2beta\//.test(endpoint)) return endpoint;
    return endpoint + (config.task === "upscale" ? "/v2beta/stable-image/generate/ultra" : "/v2beta/stable-image/control/sketch");
  }

  async function stabilityGenerate(config, input) {
    var requestHeaders = headers(config, ""), fields = { prompt: input.prompt, output_format: "png" }, files = [];
    requestHeaders.Accept = "image/*";
    if (input.imageDataUrl) {
      var image = u.dataUrlParts(input.imageDataUrl);
      var extension = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
      fields.control_strength = String(u.clamp(refStrength01(config), 0, 1));
      files.push({ name: "image", filename: "posegi." + extension, mime: image.mime, bytes: image.bytes });
    } else {
      /* 没有参考图时由服务端自己画,比例照旧锁死 —— 这里以前写死 "1:1"。 */
      fields.aspect_ratio = app.defaults.ratio;
    }
    if (config.model) fields.model = config.model;
    if (input.negativePrompt) fields.negative_prompt = input.negativePrompt;
    if (Number(input.seed) >= 0) fields.seed = String(input.seed);
    var body = u.multipart(fields, files);
    requestHeaders["Content-Type"] = body.contentType;
    var response = await network.request({ url: stabilityEndpoint(config), method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }

  /* ---------- CHP —— ComfyUI Haminn Protocol（规范 chp/2） ----------
   *
   * 一个地址、四个场景。插件自带工作流,所以客户端只报**场景名 + 画幅 + 参考图**,
   * 从不发工作流 JSON;成图也由插件自己发,提交与取图共用同一把密码。
   *
   * 三个调用各干一件事:信息接口(`endpoints.info`)说这台机器能做什么;等待期间只问
   * `endpoints.progress` 那条**轻**的(它只回状态与队列位置,不解析结果);拿到终态
   * 之后再读一次 `endpoints.job`,因为成图在那里。
   *
   * `chp/2` 与本应用上一版对接的 `chp/1` 有五处不同,每一处漏改都会静默出错图或空等:
   *   1. 请求字段 `capability` → `category`(`task` 这个旧拼写插件不再认);
   *   2. 画幅从"一对数字 + 客户端自己算"改成"帧表里的一个字符串 `resolution`";
   *   3. `steps` 与 `negative_prompt` 搬进 `ext_params`(模型层扩展通道);
   *   4. 带 body 的请求把密码放 `chp_params.password`,只有 GET 才走 `Authorization`;
   *   5. 调用地址一律从文档的 `endpoints` 里读,不再自己拼 `/chp/...`。
   * 插件声明 `spec` 不兼容时(不是 `chp/2`)这里**当场停下**,不拿旧规则继续猜。 */
  var CHP_SPEC = "chp/2";

  /* 上一次信息接口拿到的文档。它是三件事的唯一出处:这个场景在不在、它能出哪些画幅、
   * 参考图基准是多少。没测过连接时是 null,那时按出厂表发 —— 出厂值就是插件当前
   * 帧表的默认档。 */
  var chpDocument = null;
  function chpRemember(document) { if (document && document.spec) chpDocument = document; return chpDocument; }

  /* 从用户填的地址里剥出服务根。
   *
   * 三种写法都要收口:`/chp`（现在的根）、`/cvp`（更名前的别名根）、`/hamdraw/v1`
   * （更早的旧根，老卡片里可能还存着）。这里按**前缀**匹配而不是整段相等：插件界面上
   * 给出的地址是 `http://host:8189/chp/`，而 stripSlash 会先把尾斜杠吃掉，变成
   * `…/chp` —— 只匹配 `/chp/` 就再也找不到，于是根地址原样带着 `/chp` 拼出
   * `…/chp/chp/jobs`（2026-09-25 写测试时暴露的正是这一处）。
   * 正则要求词尾紧跟 `/` 或字符串结束，所以 `http://chp-host.local:8188` 这种
   * 「主机名恰好以 chp 开头」的地址不会被误切。
   *
   * 这条宽容留在**客户端**是有意的:插件那边 `/cvp` 已经整条删掉（`chp/2` 不再承诺
   * 一个 API 的两种拼法）,但用户卡片里存的旧地址是我们自己当年填进去的,得认。
   * 它现在只用来把地址收成"服务根",真正的调用路径一律从文档的 `endpoints` 读。 */
  function chpBase(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.search(/\/(?:chp|cvp|hamdraw)(?:\/|$)/i);
    return marker > 0 ? value.slice(0, marker) : value;
  }

  /* 文档 `endpoints` 里的一个地址,按用户填的那个地址解析。
     以 `/` 开头 = 与信息接口同源的路径;否则按绝对 URL 处理（契约允许把任务接口放在
     另一台机器上）。`fallback` 是**推荐**路径,只在没读过文档时用 —— 读了就不许再拼。 */
  function chpUrl(base, name, fallback) {
    var published = chpDocument && chpDocument.endpoints ? chpDocument.endpoints[name] : "";
    var value = String(published == null ? "" : published).trim() || fallback;
    if (/^https?:/i.test(value)) return value;
    return base + (value.charAt(0) === "/" ? value : "/" + value);
  }
  /* 带 `{job_id}` 占位符的那两条。`{index}` 不用换:插件给回来的 `outputs[].url`
     已经是拼好的绝对路径。 */
  function chpJobUrl(base, name, fallback, jobId) {
    return chpUrl(base, name, fallback).split("{job_id}").join(encodeURIComponent(jobId));
  }

  /* 这个场景的 `rules[]` 条目 —— 场景自己的契约。`category` 是唯一的拼法:
     `chp/2` 起没有别名,表里没有的名字就是"没有",不是"另一个叫法"。 */
  function chpRule(task) {
    var wanted = String(task == null ? "" : task).toLowerCase(), list = (chpDocument && chpDocument.rules) || [];
    if (!wanted) return null;
    return list.filter(function (item) {
      return item && String(item.category || "").toLowerCase() === wanted;
    })[0] || null;
  }
  /* 这条规则**收不收**参考图。判据取自插件公布的 `signature`(形如 `txt-ref-2-img`
     与 `txt-2-img`),不是本应用另写一张场景名单 —— 插件把某个场景改成"要参考图"或
     "不要参考图",这里当场跟着变,不用等本应用改版。
     `render`(给定一张图重新生成)与 `generate`(纯文字生成)的分界就是这一个字符
     `ref`;`generate` 收到参考图会被插件**当场拒掉**(400 bad_image),不是忽略。
     读不到规则(还没点过「测试连接」)时返回 true:本应用手上那张图本来就是要发的,
     而"多发一张它不认的图"会得到一句明确的拒绝,比"该发没发"更容易查。 */
  function chpTakesImage(rule) {
    if (!rule) return true;
    var signature = String(rule.signature || "").trim();
    if (!signature) return true;
    return signature.split("-").indexOf("ref") >= 0;
  }
  /* 这条规则**必须**带参考图(缺了就是漏参数,不是"它不需要")。 */
  function chpNeedsImage(rule) {
    return Boolean(rule && rule.needs && rule.needs.image === true);
  }
  /* 回答这个场景的那条 `abilities` 条目 —— 它是"一组能跑起来的模型文件",就绪状态
     与文件清单都挂在它身上,而不是挂在场景上(一个场景由哪条能力回答是算出来的)。 */
  function chpAbility(task) {
    var wanted = String(task == null ? "" : task).toLowerCase();
    return ((chpDocument && chpDocument.abilities) || []).filter(function (ability) {
      return ((ability && ability.frames) || []).some(function (frame) {
        return frame && String(frame.category || "").toLowerCase() === wanted;
      });
    })[0] || null;
  }
  /* 文档里那些文件挂载点,`"checkpoint → 文件名"` 一行一个,给状态行与设置界面看。 */
  function chpFiles(ability) {
    var files = ability && ability.files || {};
    return Object.keys(files).map(function (role) { return role + " " + String(files[role]); }).join(" · ");
  }
  /* 场景自报「提示词要什么语言」:`en` 是编码器只认英文,`any` 是中文也照画。
     没声明就返回 null —— 界面收到 null 会保留用户手工拨的那个开关。 */
  function chpEnglishOnly(rule) {
    var language = rule && rule.prompt && rule.prompt.language;
    if (language === "en") return true;
    if (language === "any") return false;
    return null;
  }

  /* ---------- 信息接口 ----------
   *
   * 契约把客户端的这一侧写死成一条（不是猜）:把用户填的地址**原样**当信息接口请求;
   * 若它不是 CHP 文档、且地址里没有路径,再试一次推荐的 `/chp/info`;两次都不成 ⇒
   * 报「这个地址不是 CHP 服务」。
   *
   * 两条候选的**先后**按能不能推出推荐路径来定 —— 界面上预填的那条地址就是 `…/chp`
   * (根路径),这时 `…/chp/info` 是确定的,先打它一次就够;反过来把根路径原样先打一遍
   * 只会白吃一个 404(而 404 会被记成"有人答了"),每次点「测试连接」都多一个往返。
   * 推不出来(裸源、自定义路径)时才按契约先用原样那条。
   *
   * 于是用户存过的那几种写法（裸源、`…/chp`、`…/chp/info`、更名前的 `…/cvp`）都能用,
   * 常见的那种只花一次往返;而"有东西答了、但它不是 CHP"与"压根没人答"被分成两句话 ——
   * 前者是能改的地址错,后者是网络没通,该说的不是同一件事。 */
  async function chpInfoRequest(config, requestHeaders, timeoutMs) {
    var typed = u.stripSlash(config.endpoint), root = chpBase(typed);
    var candidates = root === typed ? [typed, typed + "/chp/info"] : [root + "/chp/info", typed];
    var answered = false, firstError = null;
    for (var index = 0; index < candidates.length; index += 1) {
      if (index && candidates[index] === candidates[0]) continue;
      var response;
      try {
        response = await network.request({ url: candidates[index], method: "GET", headers: requestHeaders, timeoutMs: timeoutMs });
        ensureOk(response, requestHeaders);
      } catch (error) {
        if (!firstError) firstError = error;
        /* ComfyUI 自己的 web 根用 200 答一个页面,错路径用 404 —— 两个都是"有人答了"。
           真正没答上的是没有状态码那种(超时、连接被拒),那句错才值得留着往外报。 */
        if (Number(error && error.status) > 0) answered = true;
        continue;
      }
      answered = true;
      var doc = u.parseJson(response.bodyText || "", null);
      if (doc && doc.spec) return { status: response.status, document: doc };
    }
    if (answered) throw new Error(t("这个地址不是 CHP 服务,请确认地址指向装有 CHP 插件的 ComfyUI,并且插件装好后重启过",
      "That address is not a CHP server. Check that it points at a ComfyUI with the CHP plugin installed, and that ComfyUI was restarted after installing it."));
    throw firstError || new Error(t("连不上这个地址", "Could not reach that address"));
  }

  /* 一次公开调用回答卡片上的全部问题:地址通不通、密码对不对、场景在不在、它的模型
     装好没有、要不要先译英。信息接口是**公开**的(密码错了也照答,由 `auth.authorized`
     说明),所以前两件事一次问清,不用靠第二次失败去分辨。 */
  async function chpTest(config) {
    var requestHeaders = headers(config), timeoutMs = Math.min(Number(config.timeoutMs) || 30000, 30000);
    var found, doc;
    try {
      found = await chpInfoRequest(config, requestHeaders, timeoutMs);
    } catch (error) { throw chpError(error); }
    doc = chpRemember(found.document);
    /* 协议大版本对不上就停下。`spec` 只承诺"同一版内只加不删",跨版本则是另一回事:
       拿旧规则继续猜,请求体在新版里可能只是被忽略 —— 那比报错更难查。
       (这一条正是本应用从 chp/1 换到 chp/2 的现场:插件把能力表换成了 rules+abilities。) */
    if (String(doc.spec) !== CHP_SPEC) {
      throw new Error(t("插件的协议版本是 " + String(doc.spec) + ",本应用按 " + CHP_SPEC + " 通信:请把插件升级到配套版本",
        "The plugin speaks " + String(doc.spec) + " while this app speaks " + CHP_SPEC + ". Please update the plugin."));
    }
    var auth = doc.auth || {};
    if (auth.required === true && auth.authorized === false) {
      throw new Error(t("地址已连通,但访问密码不对 —— 请在 ComfyUI 的 CHP 插件配置节点里核对密码",
        "The address works, but the access password is wrong. Check it in the ComfyUI CHP plugin's config node."));
    }
    var wanted = chpTask(config), rule = chpRule(wanted);
    if (!rule) throw new Error(t("CHP 插件不支持“" + taskName(wanted) + "”这个场景,请升级 CHP 插件",
      "The CHP plugin does not offer the " + taskName(wanted) + " category. Please update the CHP plugin."));
    /* 就绪状态属于**能力**而不是场景:场景是客户端要什么,能力是回答它的那组文件。
       "没有这条能力"与"文件没装好"是两句不同的话 —— 前者是文档里根本没有这个场景的
       回答者,后者是文件缺了。 */
    var ability = chpAbility(wanted);
    if (!ability) throw new Error(t("插件里没有能回答“" + taskName(wanted) + "”的模型组,请在 ComfyUI 的 CHP 插件配置节点里检查",
      "The plugin has no model group answering " + taskName(wanted) + ". Check the ComfyUI CHP plugin's config node."));
    if (ability.ready === false) {
      var missing = (ability.missing || []).join(" / ");
      throw new Error(t("插件还没有为“" + taskName(wanted) + "”装好模型" + (missing ? "(缺 " + missing + ")" : "") + ",请在 ComfyUI 的 CHP 插件配置节点里设置",
        "The plugin has no model installed for " + taskName(wanted) + (missing ? " (missing " + missing + ")" : "") + ". Set it in the ComfyUI CHP plugin's config node."));
    }
    return {
      ok: true, status: found.status, protocol: "chp", spec: doc.spec,
      version: String(doc.plugin && doc.plugin.version || ""),
      task: wanted, category: wanted, label: rule.label || {},
      /* 卡上"当前模型"那一行读的是**文件挂载点**,不再是某个文件名的猜测:一条能力
         可以是一组文件(高质量生图那路是三件套),谁也不能只挑一个当它的名字。 */
      model: String(ability.name || ""), files: chpFiles(ability), fileMap: ability.files || {},
      resolution: chpResolution(config), resolutions: chpResolutions(wanted),
      ratio: app.defaults.ratio,
      authRequired: auth.required === true, authorized: auth.authorized !== false,
      englishOnly: chpEnglishOnly(rule), ready: true
    };
  }

  /* 参考图强度:卡上是 0–200(100 中性),插件要的是 0.05–0.95 的 ref_strength。
     每个场景有自己的基准 —— 图像放大的职责是把手上的图放大、不是重新演绎,所以同样
     "100"在放大卡上比在快速卡上更贴原图;高质量生图那一路没有可保留的初始 latent,
     基准 0.95 是"参考图原样送进去",调低是让插件把原稿柔化,而不是少看一眼。

     基准优先取**场景自报的 `defaults.ref_strength`** —— 那是插件认定的出厂值,插件
     换了 checkpoint 或改了默认,这里跟着走,不用等本应用改版;没测过连接时退回出厂表
     `app.defaults.chpTasks` 里那一列(`refBase`)。两边现在是一致的。 */
  function chpRefBase(task) {
    var rule = chpRule(task);
    var value = rule && rule.defaults && Number(rule.defaults.ref_strength);
    return isFinite(value) && value > 0 ? value : chpSpec(task).refBase;
  }
  function refStrength01(config) {
    var limits = app.defaults.limits.refStrength;
    var value = Number(config && config.refStrength);
    if (!isFinite(value) || value <= 0) value = 100;
    value = u.clamp(value, limits[0], limits[1]);
    return u.clamp(chpRefBase(chpTask(config)) * (value / 100), 0.05, 0.95);
  }

  /* 插件回绝的一句话,说成人能照着做的样子。匹配的是**错误码**,不是插件那句中文 ——
     它的文案在好几处都会带上"模型"两个字(比如缺节点导致的工作流失败),照着句子匹
     会把一次真的工作流失败说成"没有模型"。错误码在文档的 `errors` 里公布过,那才是
     稳定的一半。 */
  function chpError(error) {
    var text = String(error && error.message || error || "");
    if (/unauthorized|401/.test(text)) return new Error(t("访问密码不正确,请在 ComfyUI 的 CHP 插件配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI CHP plugin's config node."));
    if (/unsupported_category/.test(text)) return new Error(t("插件不认识这个场景,请升级 CHP 插件", "The plugin does not know this category. Please update the CHP plugin."));
    if (/unsupported_size/.test(text)) return new Error(t("插件不接受这个画幅;请点一次「测试连接」,读取插件当前的画幅表", "The plugin does not accept this resolution. Test the connection once to read the plugin's current frames."));
    if (/unsupported_steps/.test(text)) return new Error(t("插件不接受这个步数;请把这张卡换回它自己的出厂步数", "The plugin does not accept this step count. Put this card back on its factory step count."));
    /* 参考图的两种错共用一个码(`bad_image`):要图没给、与不收图却给了。这里读不到
       是哪种(调用点手上没有那张卡),所以两句话一起说,并且给出**唯一那条**能分辨
       它们的动作 —— 读一次插件文档。 */
    if (/bad_image/.test(text)) return new Error(t("插件说参考图不对:按图重画的场景必须带参考图,纯文字生成那一档则不能带。请点一次「测试连接」读取插件当前的场景定义,再核对模型设置里选的场景",
      "The plugin refused the reference image: reference-based categories need one, text-to-image categories must not have one. Test the connection to read the plugin's current categories, then check the one selected in the model settings."));
    if (/bad_mask/.test(text)) return new Error(t("插件说这个场景要蒙版,而本应用只做整张重画:请在模型设置里换一个不要蒙版的场景", "The plugin wants a mask for this category, and this app only repaints the whole picture. Pick a category that takes none."));
    if (/stretched_reference/.test(text)) return new Error(t("参考图与这次画幅的比例对不上,插件拒绝把它压变形;请点一次「测试连接」读取插件当前的画幅表", "The reference does not share this canvas's aspect, and the plugin refuses to stretch it. Test the connection once to read the plugin's current frames."));
    if (/no_model/.test(text)) return new Error(t("插件没有可用模型,请先在 ComfyUI 的 CHP 插件配置节点里为这个场景选好模型", "The plugin has no model. Choose the one this category runs on in the ComfyUI CHP plugin's config node."));
    if (/invalid_workflow/.test(text)) return new Error(t("插件的工作流没跑起来(多半是节点或模型缺失),请查看 ComfyUI 的控制台输出", "The plugin's workflow did not run (usually a missing node or model). Check the ComfyUI console output."));
    if (/busy|429/.test(text)) return new Error(t("插件队列已满,请稍后再试", "The plugin queue is full. Try again shortly."));
    if (/not_found/.test(text)) return new Error(t("这个任务在插件那边已经不存在了(可能已过期)", "That job no longer exists on the plugin (it may have expired)"));
    /* 宿主按 origin 授权局域网访问,没点"允许"之前请求会一直挂着,最后报超时 ——
       这句提示比原样的 "Haminn request timed out" 有用得多。 */
    if (/timed out|E_TIMEOUT/.test(text)) return new Error(t("连不上这个地址:确认手机和服务器在同一局域网,并且已经在宿主弹出的授权框里点了「允许」", "Cannot reach that address. Check that the phone and the server share a network, and that you allowed the host permission prompt."));
    if (/能力已被拒绝|拒绝了此能力|CAPABILITY_DENIED/.test(text)) return new Error(t("网络访问授权被拒绝:请重新「测试连接」,在宿主弹出的确认框里点「允许」", "Network access was denied. Test the connection again and choose Allow in the host prompt."));
    /* 宿主网络层自己的**读/写超时**。OkHttp 那边抛的是 `InterruptedIOException("timeout")`,
       宿主把它按原样包成 `E_NETWORK` 送到页面 —— 它的 message 就是**一个字的 `timeout`**,
       所以状态行上会出现孤零零一个 "timeout"(2026-09-30 真机事故现场那句话就是它)。

       它和上面那句「连不上」不是一回事:地址是通的、请求也发出去了,只是**这一次**没等到
       应答(实测:一次生成要发三四十次请求,约 4.5% 会撞上)。话必须说成"服务端的东西
       还在",否则用户会去改地址和密码 —— 而那里什么都没错。 */
    if (/^timeout$/i.test(text.trim())) {
      return new Error(t("这次请求没等到服务器应答(网络波动),服务端的任务还在:可以再点一次「立即生成新图」,或者用「重试取回」把可能已经画好的那张图取回来",
        "This request got no answer from the server (a network hiccup), but the job is still there. Generate again, or use Retrieve to fetch an image that may already be finished."));
    }
    return error;
  }

  /* ---------- 等待期间:只读请求的有界重试(2026-09-30 真机实测后加) ----------
   *
   * 现场:一次生成等了 80 多秒,最后只报一句「内部错误」,而服务端那边作业其实已经
   * 跑完、图也已经落盘 —— 图就这么丢了(手机文件库里连一个字节都没有)。
   *
   * 追下去是宿主的一个洞:它读响应体那一段没有把网络超时包成自己的 HaminnException
   * (只包了 `call.execute()`,包不到 body),于是读超时抛出的 SocketTimeoutException
   * 裸抛出来,被桥兜底成 `E_INTERNAL` +「内部错误」。真机按 700ms × 110 次的真实节奏
   * 压过同一个接口:**110 次里 5 次**就是这种读超时(每次约 15 秒,正是轮询那个超时值)。
   *
   * 所以这里的原则是:**等待期间所有"只读"的请求都带有限重试**。一次瞬时故障不该让
   * 一整张已经生成好的图丢掉。提交那一次(POST)绝不重试 —— 那不是"再问一次",
   * 那是在服务端多排一个作业。
   *
   * 重试上限 3 次、之间退避 400ms。按实测那 4.5% 的单次失败率,三次全挂的概率约
   * 万分之一,而代价只是一次多等 1.2 秒。 */
  var POLL_RETRY = 3;

  /* 哪些错重试也没用。判据只认**插件明确拒绝**的那几种:密码不对、不认识场景 /
   * 画幅 / 步数、参考图给错了(要的没给 / 不要的给了)、没有模型、工作流没跑起来。
   * 那些再问一万次也是同一个结果,早点报出来才对;其余(含那句没有任何信息量的
   * 「内部错误」)一律当瞬时。 */
  function chpTerminal(error) {
    var text = String(error && error.message || error || "");
    return /unauthorized|401|unsupported_category|unsupported_size|unsupported_steps|stretched_reference|bad_image|bad_mask|bad_request|no_model|invalid_workflow|能力已被拒绝|拒绝了此能力|CAPABILITY_DENIED/.test(text);
  }

  /* 只读请求:重试到上限,仍不行就把(已翻译的)错误抛出去。
   * options 同时用来做 ensureOk 的脱敏 —— 里面带着那把密码,报错里不许出现它。 */
  async function chpReadQuiet(options) {
    var last = null;
    for (var attempt = 0; attempt < POLL_RETRY; attempt += 1) {
      if (attempt) await u.sleep(400 * attempt);
      try {
        var response = await network.request(options);
        ensureOk(response, options.headers || {});
        return response;
      } catch (error) {
        last = chpError(error);
        if (chpTerminal(error)) throw last;
        if (attempt + 1 < POLL_RETRY) {
          app.events.emit("generation:progress", { stage: "running",
            detail: t("和服务器的一次通信没成功,正在重试…", "One request to the server failed; retrying…") });
        }
      }
    }
    throw last;
  }

  /* ---------- 提交幂等键:让"重发"变成安全动作(2026-09-30 真机事故后加) ----------
   *
   * 现场:POST 已经把作业交给服务端了,应答却在回程被宿主的读超时掐断(页面看到的
   * 是裸的一个 `timeout`)。客户端手上既没有 job id、也没有图,而服务端那边作业照跑、
   * 图照落盘 —— 那张图从此再没人能取回来。
   *
   * 判据:提交这一步**必须能重发**,可重发一个"没有身份"的 POST 就等于让服务端多画一张。
   * 补法就是给这次提交一个身份 —— `chp/2` 的 `request_id`。同一个键重发,插件把原来
   * 那个作业还回来(`replayed: true`),不会再排一个。于是重发安全了,上面那个洞也就堵上了。
   *
   * 取值只要**一次提交一个、重发时不变**。换了内容就换一个值(插件按"键 + 内容指纹"
   * 认重放,指纹不同不算重放,这里不必自己防)。 */
  function chpNewRequestId() {
    return "posegi-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* 提交最多试两次:第一次"真送到了、只是应答丢了"的情况,恰是这个重试要救的。
     插件明确回绝的那几种(密码不对 / 画幅不认识 / 步数不认识……)当场抛出去 ——
     重发一万次也是同一个结果,判据复用 chpTerminal。 */
  var SUBMIT_ATTEMPTS = 2;

  async function chpSubmit(config, base, requestHeaders, body, label) {
    var last = null;
    for (var attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
      if (attempt) {
        await u.sleep(600);
        app.events.emit("generation:progress", { stage: "submit",
          detail: t("这次提交没等到应答,正在用同一个提交编号重发(不会重复出图)…",
            "No answer to this submission; resending under the same request id (it will not queue a second job)…") });
      }
      try {
        var submitted = await network.request({
          url: chpUrl(base, "jobs", "/chp/jobs"), method: "POST",
          headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs
        });
        ensureOk(submitted, requestHeaders);
        return u.parseJson(submitted.bodyText || "", null) || {};
      } catch (error) {
        last = chpError(error);
        if (chpTerminal(error)) throw last;
      }
    }
    throw last || new Error(t("提交" + label + "任务失败", "Failed to submit the " + label + " job"));
  }

  /* 等待期间那一句进度文案。插件**不报百分比**(契约明说 `progress` 恒为 null),
     报的是**队列位置** —— 那是个每个实现都算得出来的整数,所以照它说「前面还有几个」,
     比编一个假的百分比诚实。 */
  function chpProgressText(task, job) {
    var label = taskLabel(task), state = String(job && job.state || "");
    var position = job && job.queue_position;
    if (state === "queued") {
      if (typeof position === "number" && position > 0) {
        return t(label + "排队中,前面还有 " + position + " 个任务…", label + " queued behind " + position + " job(s)…");
      }
      return t(label + "排队中…", label + " queued…");
    }
    return t(label + "进行中…", label + " in progress…");
  }

  /* 插件的**服务端**回绝,原话报给用户:状态是 failed(不是 HTTP 错)时,原因只有
     job.error 里有 —— 少了它,界面只能说"执行失败",而那正是要查的东西。 */
  function chpFailure(job) {
    var reason = String(job && job.error || "").trim();
    return new Error(t("插件工作流执行失败" + (reason ? ":" + reason : ""), "The plugin workflow failed" + (reason ? ": " + reason : "")));
  }

  /* 一个**可以再试一次**的失败。
   *
   * 判据不是"错得多严重",而是"服务端那边那个作业还算不算数":只要 job id 还在,
   * 图就还有可能已经画好了,只是这次没取回来 —— 那就不该报成死讯。
   * 带上 jobId 是给界面看的:它据此给一个「重试取回」,而不是让用户重画一张
   * (重画要再等几十秒,而且那几十秒本来白花)。
   *
   * 注意它**不是** `chpTerminal` 的那几种:密码不对、画幅不认识……那些作业根本
   * 没排上,谈不上取回,照旧当场报出去。 */
  function chpRecoverable(message, jobId) {
    var error = new Error(message);
    error.recoverable = true;
    error.jobId = String(jobId || "");
    return error;
  }

  /* 作业已完成 ⇒ 把图取回来。与 chpGenerate 后半段走的是**同一条路**
     (拼 outputs[0].url → 下载 → 解成 dataUrl),区别只在于作业可能是上一次提交的。 */
  async function chpFetchOutput(config, base, job) {
    var output = job && job.outputs && job.outputs[0];
    if (!output || !output.url) throw chpFailure(job || {});
    /* `endpoints` 说主根是 `/chp` 时,`outputs[].url` 就是根相对路径,拼 base 即可;
       实现若把任务接口放到别处(绝对 URL),这里也照它给的那条走。 */
    var imageUrl = /^https?:/i.test(output.url) ? output.url : base + output.url;
    app.events.emit("generation:progress", { stage: "download", detail: t("正在读取生成图片…", "Loading the generated image…") });
    /* 图就在服务端,一次瞬时故障就把它扔掉是最可惜的(17:53 那次丢的就是它)。 */
    var downloaded = await chpReadQuiet({ url: imageUrl, method: "GET", headers: headers(config), timeoutMs: 60000 });
    var result = await responseImage(downloaded, headers(config));
    result.metadata = job;
    return result;
  }

  /* 续取:按记下来的 job id 再看一眼。三种结局 ——
       还在排队 / 执行中 ⇒ `{ running: true }`,这不是失败,界面照旧等它;
       已完成           ⇒ 把图取回来,与正常生成返回的东西一模一样;
       失败 / 已被清掉   ⇒ 抛出原话(不存在 = 服务端已经把它清掉了,这个键也就作废)。
     读不到(网络又断一次)时抛的是**可续取**的错,用户还能再点一次。 */
  async function chpResume(config, pending) {
    var base = chpBase(config.endpoint);
    var record = pending || app.state.pendingJob;
    var jobId = String(record && record.jobId || "");
    if (!jobId) throw new Error(t("没有等待取回的任务", "There is no job waiting to be retrieved"));
    var response = await chpReadQuiet({
      url: chpJobUrl(base, "job", "/chp/jobs/{job_id}", jobId),
      method: "GET", headers: headers(config), timeoutMs: 30000
    });
    var payload = u.parseJson(response.bodyText || "", null), job = payload && payload.job;
    if (!job) throw new Error(t("插件没有返回这个任务", "The plugin returned no such job"));
    var state = String(job.state || "");
    if (state === "failed") throw chpFailure(job);
    if (state === "cancelled") throw new Error(t("任务已取消", "The job was cancelled"));
    if (state !== "completed") return { running: true, job: job };
    return { running: false, job: job, result: await chpFetchOutput(config, base, job) };
  }

  async function chpGenerate(config, input) {
    var base = chpBase(config.endpoint), task = chpTask(config);
    /* 密码**只走一个载体**:带 body 的请求放 `chp_params.password`,所以这里的请求头
       不带 Authorization(GET 才走头)。自定义头原样保留,用户就是靠它做反代的。 */
    var requestHeaders = chpHeaders(config, "application/json");
    /* 画幅:只有一条,而且**就是插件帧表里那条字符串**,原样发回去(见 chpResolution)。
       这个场景在插件上还没有 9:16 档时这里没有值可发 —— 当场说清是哪个场景缺,
       而不是发一个必 400 的占位值。 */
    var chosen = chpResolution(config);
    if (!chosen) {
      throw new Error(t("插件还没有为“" + taskName(task) + "”公布 " + app.defaults.ratio + " 的分辨率:请在 ComfyUI 的 CHP 插件配置节点里给这个场景加一档竖幅",
        "The plugin publishes no " + app.defaults.ratio + " resolution for " + taskName(task) + ". Add a portrait frame for that category in the ComfyUI CHP plugin's config node."));
    }
    /* 参考图附不附**由插件那条规则说了算**:`render` / `fast` / `upscale` 的规则是
       `txt-ref-2-img`,带图;`generate` 是 `txt-2-img`,带了会被当场拒掉(400 bad_image)。
       反过来,规则声明 needs.image 却没图是漏参数 —— 那种请求发出去只会让用户在等
       一张注定 400 的图,所以在这里就说清是哪一种缺。 */
    var rule = chpRule(task);
    var takes = chpTakesImage(rule), needs = chpNeedsImage(rule);
    var reference = takes && input.imageDataUrl ? String(input.imageDataUrl) : "";
    if (needs && !reference) {
      throw new Error(t("“" + taskName(task) + "”这一档必须带参考图(它就是按图重画那条路):请先在画布上摆好造型再生成",
        "The \"" + taskName(task) + "\" category requires a reference image: pose the figure on the canvas first."));
    }
    /* 模型层的那个通道:只放**本应用自己要发**的扩展键。步数不在其中 ——
       `chp/2` 要客户端报的只有 seed 与画幅,步数属于插件那台机器的加速档案
       (见文件头「关于 steps」)。这里多发的每一个字节,都会把一台配好加速的机器
       按回默认步数上,而那种退化从成图上看不出来。 */
    var ext = {};
    if (input.negativePrompt) ext.negative_prompt = input.negativePrompt;
    var body = {
      /* 场景名就是卡上那一栏,不再有第二套词要换算 */
      category: task,
      /* 画幅是**字符串**,而且只能逐项命中插件那张帧表 —— 挑的动作在 chpResolution 里,
         挑的是标着 9:16 的那一档,发出去的这个字面量就是表里那个字面量。 */
      resolution: chosen,
      prompt: input.prompt,
      seed: Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 9007199254740991),
      ext_params: ext
    };
    /* 参考图权重只在**真的带图**时有意义:`generate` 那条路没有原稿可柔化,发它等于
       发布一个按了没反应的旋钮。不带就由插件按类别默认给一个确定的数。 */
    if (reference) body.ref_strength = refStrength01(config);
    if (config.apiKey) body.chp_params = { password: config.apiKey };
    if (reference) body.image_base64 = reference;
    var label = taskLabel(task);
    /* 幂等键**必须在提交之前就定下来**,而且整个重试过程里不变 ——
       它认的就是"这是同一次提交"。见 chpNewRequestId。 */
    body.request_id = chpNewRequestId();
    app.events.emit("generation:progress", { stage: "submit", detail: t("正在提交" + label + "任务…", "Submitting the " + label + " job…") });
    var accepted = await chpSubmit(config, base, requestHeaders, body, label);
    var jobId = accepted.job && accepted.job.id;
    if (!jobId) throw new Error(t("插件未返回任务 ID,请确认插件版本与地址", "The plugin did not return a job id. Check its version and address."));
    /* 作业已经在服务端了 —— 当场把它记下来交给上层落盘(app.state.pendingJob)。
       从这一刻起,无论后面怎么断(用户杀进程、手机重启、网络再断一次),这个 id
       都把服务端那张图找得回来。这里只发事件,不认识 store。 */
    app.events.emit("generation:pending", { pending: {
      jobId: jobId, task: task, requestId: body.request_id, createdAt: Date.now()
    } });
    /* 插件把**忽略掉的顶层字段**名字回执回来。本应用现在发的都是它认的字段,所以这里
       平时是空的;留着一句是因为它一旦不空,就意味着"某个字段改名之后这边还没跟着改"
       —— 那种静默失效正是这条回执要拦住的东西。 */
    var ignored = (accepted.job && accepted.job.ignored) || [];
    if (ignored.length) {
      app.events.emit("generation:progress", { stage: "submit", detail: t("插件忽略了这些字段:" + ignored.join("、"),
        "The plugin ignored these fields: " + ignored.join(", ")) });
    }
    /* 等待期间只问那条**轻**的进度路由(它只回状态与队列位置,不解析成图,是插件专门
       给轮询用的);拿到终态之后再读一次完整状态,取回成图。两条地址都在这里读一次,
       免得一场作业中途换到别的路径上去。 */
    var progressUrl = chpJobUrl(base, "progress", "/chp/jobs/{job_id}/progress", jobId);
    var deadline = Date.now() + (Number(config.timeoutMs) || 120000), state = "", failure = null;
    while (Date.now() < deadline) {
      await u.sleep(700);
      /* 轮询这条尤其要能扛住瞬时故障:这里失败一次,服务端那张**已经生成好的图**
         就没人来取了(成因见上面 chpReadQuiet 那段注释)。 */
      var polled = await chpReadQuiet({ url: progressUrl, method: "GET", headers: headers(config), timeoutMs: 15000 });
      var brief = u.parseJson(polled.bodyText || "", null), progress = brief && brief.job;
      if (!progress) continue;
      state = String(progress.state || "");
      if (state === "failed") { failure = progress; break; }
      if (state === "cancelled") {
        /* 作业有了定论:服务端那边不会再产出图,记着的那个 id 已经没用了 */
        app.events.emit("generation:pending", { pending: null });
        throw new Error(t("任务已取消", "The job was cancelled"));
      }
      if (state === "completed") break;
      app.events.emit("generation:progress", { stage: "running", detail: chpProgressText(task, progress) });
    }
    /* 轻的那条只报状态;失败的原因在完整的那个 job 里,而它现在还没读过 ——
       所以失败时补读一次,把那句话取回来。 */
    if (failure) {
      var detail = null;
      try {
        var failureResponse = await network.request({ url: chpJobUrl(base, "job", "/chp/jobs/{job_id}", jobId), method: "GET", headers: headers(config), timeoutMs: 15000 });
        ensureOk(failureResponse, headers(config));
        detail = (u.parseJson(failureResponse.bodyText || "", null) || {}).job;
      } catch (error) { detail = null; }
      /* 插件自己说这个工作流失败了 —— 那是定论,不是"没取到":没有图可取,别再留着 id */
      app.events.emit("generation:pending", { pending: null });
      throw chpFailure(detail || failure);
    }
    /* 等到最后也没等到终态。**这不是"生成失败"**:服务端那张图可能已经画好了,
       只是我们还没听到。所以这句话不能说成死讯,而且要**带着 job id**往上抛 ——
       界面据此给一个「重试取回」,而不是让用户白等第二次。 */
    if (state !== "completed") {
      var waited = Math.round((Number(config.timeoutMs) || 120000) / 1000);
      throw chpRecoverable(t("等了 " + waited + " 秒还没等到结果,服务端的任务可能还在跑:可以用「重试取回」再取一次,不必重画一张",
        "Waited " + waited + "s without a result; the job may still be running. Use Retrieve to fetch it again instead of rendering a new one."), jobId);
    }
    /* 作业已经完成了,从这里往后每失败一次都等于白扔一张图 —— 一律走带重试的读。 */
    var statusUrl = chpJobUrl(base, "job", "/chp/jobs/{job_id}", jobId);
    var status = await chpReadQuiet({ url: statusUrl, method: "GET", headers: headers(config), timeoutMs: 30000 });
    var payload = u.parseJson(status.bodyText || "", null), done = payload && payload.job;
    if (!done) throw new Error(t("任务已完成,但插件没有返回结果", "The job completed but the plugin returned no result"));
    var output = done.outputs && done.outputs[0];
    if (!output || !output.url) throw new Error(t("任务完成,但没有图片输出", "The job finished without an image"));
    /* 取图这一步失败更冤:作业已经完成、输出地址也拿到了,只差把字节搬回来。
       所以这里不报死讯,而是抛一个带 job id 的可续取错 —— 用户点一次「重试取回」
       就能拿到,不用重画。 */
    var result;
    try {
      result = await chpFetchOutput(config, base, done);
    } catch (error) {
      if (chpTerminal(error)) throw error;
      app.events.emit("generation:progress", { stage: "download",
        detail: t("图已经画好了,但这次没取回来…", "The image is ready but this fetch failed…") });
      throw chpRecoverable(t("图已经画好了,但这次没取回来(网络波动):用「重试取回」再取一次就好,不必重画",
        "The image is ready, but this fetch failed (a network hiccup). Use Retrieve to fetch it — no need to render again."), jobId);
    }
    /* 图到手了,记着的那个 id 就此作废 */
    app.events.emit("generation:pending", { pending: null });
    return result;
  }

  /* ---------- 出口 ---------- */

  /* 续取上一次没取回来的那张图(见 chpResume 与 app.state.pendingJob)。
     只有 CHP 需要它:它把"提交"和"取结果"分成了两次请求,中间隔着几十秒;
     别的协议一次请求就把图拿回来了,没有"作业编号"这个东西可续。
     所以这是一个窄出口,不是又一个协议分支。 */
  async function resume(config, pending) {
    if (!config || config.protocol !== "chp") {
      throw new Error(t("只有 CHP 插件支持「重试取回」", "Retrieve is only available for the CHP plugin"));
    }
    return chpResume(config, pending);
  }

  async function generate(config, input) {
    validate(config);
    if (config.protocol === "chp") return chpGenerate(config, input);
    if (config.protocol === "openai-images") return openAiGenerate(config, input);
    if (config.protocol === "sd-webui") return sdWebuiGenerate(config, input);
    if (config.protocol === "stability") return stabilityGenerate(config, input);
    throw new Error(t("不支持的图像接口协议:", "Unsupported image API: ") + String(config.protocol || ""));
  }

  function validate(config) {
    if (!config) throw new Error(t("模型配置不存在", "The model config is missing"));
    u.validateEndpoint(config.endpoint);
    /* 画幅的判据是**成员校验**而不是区间:比例锁死之后,"在 512–1024 之间"这种话
       说不清是宽还是高,而真正会出错的是"这个接口不接受这条分辨率"。
       CHP **不在这里判**:它的画幅是插件帧表里的成员,选的动作在 chpResolution 里,
       这里再抄一份就成了"客户端自己算出来、服务端再判一次"的第二份规则。 */
    if (config.protocol !== "chp") {
      var value = String(config.resolution || "").trim();
      if (!RESOLUTION_FORM.test(value)) throw new Error(t("请选择生成分辨率", "Choose an output resolution"));
      if (!ratioMatches(value)) {
        throw new Error(t("生成分辨率必须是 " + app.defaults.ratio + " 的竖幅:" + value + " 不是",
          "The output resolution must be " + app.defaults.ratio + " portrait; " + value + " is not"));
      }
      if ((app.defaults.resolutions || []).indexOf(value) < 0) {
        throw new Error(t("生成分辨率不在可选清单里:" + value, "That output resolution is not on the list: " + value));
      }
    }
    if (config.protocol === "stability" && !config.apiKey && !u.isPrivateHost(new URL(config.endpoint).hostname)) throw new Error(t("请先填写 API Key", "Enter an API key first"));
    if (config.protocol === "openai-images" && !config.model) throw new Error(t("请填写图像模型 ID", "Enter the image model id"));
    u.parseHeaders(config.customHeaders || "");
    /* 别处也不再抄插件那张 256–2048 的旧数值域。 */
  }

  /* 测试连接 = 只读一遍对方的自描述,绝不触发生图。
     CHP 那条走信息接口(见 chpTest),一次回答:地址通不通、密码对不对、场景在不在、
     它的模型装好没有、要不要先译英、这次会用什么画幅。 */
  async function test(config) {
    validate(config);
    var requestHeaders = headers(config);
    if (config.protocol === "chp") return chpTest(config);
    var root, url;
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
    ensureOk(response, requestHeaders);
    return { ok: true, status: response.status, protocol: config.protocol };
  }

  /* ---------- 生成前的自检 ----------
   *
   * 用户 2026-09-30 要求:「每次点击生成图片之前,先检测当前选定的模型是否能正常使用,
   * 如果不能正常使用,就弹窗提示用户去设置模型(按钮跳转过去)」。
   *
   * 两道:
   *   本地 —— 与生成时**同一个 validate**(全应用只有这一份),所以"点了生成才发现
   *           配置缺东西"这件事在这里就拦住了;CHP 的画幅也归这一道(插件没给这个
   *           场景公布 9:16 档 ⇒ 必然 400),判据与 chpGenerate 里那一句完全相同。
   *   远端 —— 借 test():它就是"这个地址通不通、密码对不对、模型装好没有"的答案。
   *
   * 为什么远端那一问要用一个**自己的**超时:`test` 用的是卡上那个超时(高质量生图那张
   * 是 300 秒),地址填错时用户得盯着"正在检查模型"站五分钟。这里换成 PROBE_TIMEOUT_MS,
   * 到点就当"连不上"处理 —— 那正是要说给他听的那句话。
   *
   * 顺带一个好处:CHP 的这一问会把插件文档重新读一遍,于是紧接着的画幅判定用的是插件的
   * **当前**帧表,而不是上一次「测试连接」时留下的旧表。
   *
   * 返回 { ok, reason }:**不抛**。调用方(生成流程)要的是"能不能发",而不是一个异常。
   */
  var PROBE_TIMEOUT_MS = 8000;

  async function preflight(config) {
    if (!config) {
      return { ok: false, reason: t("还没有可用的模型卡,请先在模型设置里建一张", "No model card yet. Add one in the model settings first.") };
    }
    try {
      validate(config);
    } catch (error) {
      return { ok: false, reason: u.cleanError(error) };
    }
    if (config.protocol === "chp" && !chpResolution(config)) {
      return { ok: false, reason: t("插件还没有为“" + taskName(chpTask(config)) + "”公布 " + app.defaults.ratio + " 的分辨率:请在 ComfyUI 的 CHP 插件配置节点里给这个场景加一档竖幅",
        "The plugin publishes no " + app.defaults.ratio + " resolution for " + taskName(chpTask(config)) + ". Add a portrait frame for that category in the ComfyUI CHP plugin's config node.") };
    }
    var probe = u.merge({}, config);
    probe.timeoutMs = PROBE_TIMEOUT_MS;
    try {
      await test(probe);
    } catch (error) {
      return { ok: false, reason: u.cleanError(error) };
    }
    return { ok: true, reason: "" };
  }

  /* 新建一张卡:按协议给一份能直接用的默认值。
     task 取 "fast" / "upscale" / "render"(就是插件的场景名),决定出厂画幅、步数、
     超时与参考图基准(数值全部来自 app.defaults.chpTasks)。非 CHP 协议只有
     "快速 / 放大"两种语义,所以在别的接口下 task 一律收成这两个 —— 否则从高质量
     生图那张卡切到 SD WebUI 会得到一张步数 20 的怪卡。
     画幅一律来自 app.defaults.resolutions(9:16 那份清单),CHP 卡的例外见 chpResolution。 */
  function preset(protocol, task) {
    var chp = protocol === "chp";
    var wanted = chp ? chpTask({ task: task }) : (task === "upscale" ? "upscale" : "fast");
    var spec = chpSpec(wanted);
    var list = app.defaults.resolutions || [];
    /* "重"的那两档(放大 / 高质量生图)—— 只用来选非 CHP 协议的出厂画幅与步数,
       以及在 openai-images 那张卡上标 quality。CHP 卡不看它(画幅与步数由插件定)。 */
    var heavy = wanted === "upscale" || wanted === "render";
    var value = {
      id: u.id("model"),
      name: taskName(wanted),
      protocol: protocol, task: wanted,
      endpoint: "", apiKey: "", model: "", customHeaders: "",
      /* 画幅在 chp 卡上只是"还没读过插件时的出厂值"(见 chpResolution);别的协议它才是
         用户真正挑的那条。轻的那档给 576x1024(正好 9:16 且高度 1024),重的给清单末档。 */
      resolution: chp ? spec.resolution : String(heavy ? list[list.length - 1] : list[1] || list[0] || ""),
      steps: spec.steps,
      refStrength: 100,
      quality: heavy ? "high" : "low",
      /* 新建的卡默认不吃英文翻译。字段必须在这里出现,否则"从旧卡切协议"时
         会被整份覆盖掉(见 settings.js 里切协议那段)。 */
      needsEnglish: false,
      timeoutMs: spec.timeoutMs
    };
    if (chp) {
      /* 空地址对用户没有任何信息量,给一条带 IP 的样例他照着改就行。
         真正显示在表单里的是 settings 那一处(见 renderModelForm),
         这里填的是"这张卡带着的默认值"。 */
      value.endpoint = app.defaults.chpEndpoint;
    } else if (protocol === "openai-images") {
      value.endpoint = "https://api.openai.com/v1";
      value.model = "gpt-image-1";
    } else if (protocol === "sd-webui") {
      value.endpoint = "http://192.168.1.2:7860";
      value.steps = heavy ? 28 : 6;
    } else if (protocol === "stability") {
      value.endpoint = "https://api.stability.ai";
    }
    return value;
  }

  function byId(id) {
    var list = app.config && app.config.models || [];
    return list.filter(function (item) { return item.id === id; })[0] || null;
  }

  /* 当前该用哪张卡:模型设置里激活的那张;它没了(被删)就退回第一张。 */
  function active() {
    var list = app.config && app.config.models || [];
    return byId(app.state.activeModelId || app.config && app.config.activeModelId) || list[0] || null;
  }

  app.services.providers = {
    protocols: PROTOCOLS,
    generate: generate,
    /* 续取上一次提交、但没取回来的那张图(见 app.state.pendingJob) */
    resume: resume,
    test: test,
    /* 生成前自检:本地配置 + 一次有超时的远端探活,返回 { ok, reason } 而不抛 */
    preflight: preflight,
    validate: validate,
    preset: preset,
    byId: byId,
    active: active,
    /* 界面与作品卡上显示分辨率用这个:chp 卡上它取的是**真正会发出去**的那一条,
       不是卡上存的那个数(那个数只是没读过插件时的出厂值)。 */
    resolutionText: resolutionText,
    internals: {
      openAiRoot: openAiRoot,
      chpBase: chpBase,
      chpTask: chpTask,
      chpKnown: chpKnown,
      chpSpec: chpSpec,
      chpResolution: chpResolution,
      chpResolutions: chpResolutions,
      /* 界面上的场景清单与它们的名字/说明 —— 一律"插件优先、出厂兜底"
         (见 providers 那一段的注释)。settings 里那一排任务按钮与它下面那句话读这里。 */
      chpCategories: chpCategories,
      /* 场景自己的契约条目,以及从它 `signature` 算出来的两条判据:
         "这一档收不收参考图" / "是不是必须带" —— 提交体按它们决定附不附那张图。 */
      chpRule: chpRule,
      chpTakesImage: chpTakesImage,
      chpNeedsImage: chpNeedsImage,
      taskDescription: taskDescription,
      chpUrl: chpUrl,
      taskName: taskName,
      refStrength01: refStrength01,
      chpTerminal: chpTerminal,
      chpReadQuiet: chpReadQuiet,
      /* 幂等键 / 安全提交 / 可续取的失败 / 取输出 —— 四条都是"不丢图"那条线上的,
         测试直接读它们(见 tests/providers.test.mjs)。 */
      chpNewRequestId: chpNewRequestId,
      chpSubmit: chpSubmit,
      chpRecoverable: chpRecoverable,
      chpFetchOutput: chpFetchOutput,
      chpResume: chpResume,
      SUBMIT_ATTEMPTS: SUBMIT_ATTEMPTS,
      jsonImage: jsonImage,
      resolution: resolution,
      pairOf: pairOf,
      ratioMatches: ratioMatches
    }
  };
})(window.posegi);
