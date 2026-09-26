/* 生图接口适配:把统一请求翻译成各家本地服务的协议
 *
 * 责任:只做协议翻译,不做编排、不做重试、不读 app.state。
 * 约定:每个协议实现 generate(config, input) → { src, logicalFileId?, metadata }
 *
 * config(模型卡,见 app.defaults.models)关键字段:
 *   protocol  "cvp" | "openai-images" | "sd-webui" | "stability"
 *   endpoint  服务器地址;apiKey 访问密码 / API Key
 *   size      生成分辨率(512–1024,正方)      → width = height = size
 *   refStrength 参考图强度(0–200,100 为中性) → 只对 cvp 生效,见 cvpStrength
 *   steps / timeoutMs / customHeaders / task(仅 cvp)
 *
 * input(由 image-engine 组装):
 *   { prompt, negativePrompt, seed, imageDataUrl, mime }
 *   imageDataUrl 永远是 1024 边的渲染参考图(见 app.defaults.reference)
 *
 * 选型说明(照抄 vibedraw 已经跑通的那一套):
 *   - cvp(ComfyUI Vibedraw Plugin)是推荐路径:插件自带工作流,客户端只报任务名 + 参考图,
 *     而且成图由插件自己发,提交与取图共用一把密码。
 *   - sd-webui 最省事:一次 POST /sdapi/v1/img2img,参考图直接放 init_images。
 *   - openai-images 走 /v1/images/edits(multipart),纯文字走 /v1/images/generations。
 *   - stability 走 v2beta 的 control/sketch(图)与 generate/core(文)。
 */
(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.hermit;

  function t(zh, en) { return app.i18n ? app.i18n.text(zh, en) : zh; }

  var PROTOCOLS = [
    { id: "cvp", name: "ComfyUI Vibedraw Plugin(推荐)",
      description: "连接装有 VibeDraw 插件的 ComfyUI。插件自带快速生图、渲染与 Qwen 图像三套工作流,不需要导出工作流 JSON;密码在插件的配置节点里设置。" },
    { id: "openai-images", name: "OpenAI Images 兼容",
      description: "兼容 /v1/images/generations 与 /v1/images/edits,适合云端与兼容网关。" },
    { id: "sd-webui", name: "SD WebUI / Forge",
      description: "兼容 /sdapi/v1/img2img,适合局域网 Stable Diffusion WebUI 或 Forge。" },
    { id: "stability", name: "Stability AI",
      description: "兼容 Stable Image v2beta 的 Control Sketch 与 Generate 接口。" }
  ];

  /* ---------- CVP 的任务 ----------
   *
   * 插件自带工作流,客户端只报任务名 —— 所以 CVP 的 task 就是卡上那一栏,
   * 取值只有 quick / upscale / qwen 三个,出厂参数(画幅范围、步数、参考图基准、
   * 超时)全部来自 app.defaults.cvpTasks,这里只做查询与兜底。 */
  function cvpSpec(task) { return app.defaults.cvpTasks[task] || app.defaults.cvpTasks.quick; }
  function cvpTask(config) {
    var value = String(config && config.task || "");
    return Object.prototype.hasOwnProperty.call(app.defaults.cvpTasks, value) ? value : "quick";
  }
  function taskName(task) {
    if (task === "upscale") return t("渲染出图", "Render");
    if (task === "qwen") return t("Qwen 图像 2.1", "Qwen Image 2.1");
    return t("快速生图", "Quick draw");
  }
  /* 请求里报的那个短名字,用在进度提示上 */
  function taskLabel(task) {
    if (task === "upscale") return t("渲染", "Render");
    if (task === "qwen") return t("Qwen 图像", "Qwen image");
    return t("快速生图", "Quick draw");
  }

  function headers(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    if (config.apiKey && !output.Authorization && !output.authorization) output.Authorization = "Bearer " + config.apiKey;
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

  /* ---------- 画幅 ---------- */

  function side(config) {
    var limits = app.defaults.limits.size;
    return Math.round(u.clamp(Number(config && config.size) || 512, limits[0], limits[1]));
  }
  function sizeText(config) { return side(config) + "x" + side(config); }

  /* CVP 的画幅必须落在插件自己报出来的那几档上,否则会被 400 顶回来:
     quick 只有 512,渲染只有 1024(插件还有 2048,但本应用的画幅上限就是 1024),
     Qwen 是 512–1024 每 64 一档。所以这里按任务的 [最小, 最大, 步进] 夹取并吸附。 */
  function cvpSize(config) {
    var spec = cvpSpec(cvpTask(config)).size;
    var low = Math.max(spec[0], app.defaults.limits.size[0]);
    var high = Math.min(spec[1], app.defaults.limits.size[1]);
    var value = Math.round(Number(config && config.size) || low);
    value = Math.round(value / spec[2]) * spec[2];
    return Math.round(u.clamp(value, low, high));
  }
  function cvpSizeText(config) { return cvpSize(config) + "x" + cvpSize(config); }

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
        size: sizeText(config),
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
        bodyText: JSON.stringify({ model: config.model, prompt: input.prompt, n: 1, size: sizeText(config), quality: config.quality || "auto", response_format: "b64_json" })
      });
    }
    return responseImage(response, requestHeaders);
  }

  /* ---------- SD WebUI / Forge ---------- */

  async function sdWebuiGenerate(config, input) {
    var url = u.stripSlash(config.endpoint) + "/sdapi/v1/" + (input.imageDataUrl ? "img2img" : "txt2img");
    var requestHeaders = headers(config, "application/json");
    var value = side(config);
    var body = {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      width: value,
      height: value,
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
      fields.aspect_ratio = "1:1";
    }
    if (config.model) fields.model = config.model;
    if (input.negativePrompt) fields.negative_prompt = input.negativePrompt;
    if (Number(input.seed) >= 0) fields.seed = String(input.seed);
    var body = u.multipart(fields, files);
    requestHeaders["Content-Type"] = body.contentType;
    var response = await network.request({ url: stabilityEndpoint(config), method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }

  /* ---------- CVP —— ComfyUI Vibedraw Plugin(schema vibedraw-comfy/v2) ----------
   *
   * 一个地址、三种任务。插件自带工作流,所以客户端只报任务名与参考图,
   * 从不发工作流 JSON;成图也由插件自己发,提交与取图共用同一把密码。 */

  /* 从用户填的地址里剥出服务根。
   *
   * 这里必须匹配 `/vibedraw`(**不带尾斜杠**):插件界面上给出的接口地址是
   * `http://host:8189/vibedraw/`,而 stripSlash 会先把尾斜杠吃掉,变成
   * `…/vibedraw` —— 匹配 `/vibedraw/` 就再也找不到,于是根地址原样带着
   * `/vibedraw` 拼出 `…/vibedraw/vibedraw/v1/jobs`(2026-09-25 写测试时暴露)。
   * 匹配 `/vibedraw` 之后,`/vibedraw`、`/vibedraw/`、`/vibedraw/v1/jobs` 三种写法都能正确收口。 */
  function cvpBase(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.indexOf("/vibedraw");
    return marker >= 0 ? value.slice(0, marker) : value;
  }

  /* ---------- CVP 的 API 发现 ----------
   *
   * 插件 v2.1 起自报"这台机器上有哪些任务、各自收什么、要不要先译英",客户端不再
   * 需要把任务表写死在自己代码里(2026-09-26 用户要求)。
   *
   * 优先打 `/vibedraw/v1/plugins`:它的职责就是这个,而且**密码填错也照答**
   * (由 `auth.authorized` 说明),所以"地址对不对"和"密码对不对"一次就能问清。
   * v2.0.x 没有这个路由,退回 `/capabilities` —— v2.1 起那边也带同一份
   * `plugins` / `prompt_policy`。两条都拿不到 JSON 就返回 null,调用方按老行为继续,
   * 那不是错误。 */
  async function cvpDiscovery(config) {
    var base = cvpBase(config.endpoint), requestHeaders = headers(config);
    var timeoutMs = Math.min(Number(config.timeoutMs) || 30000, 30000);
    var response = await network.request({ url: base + "/vibedraw/v1/plugins", method: "GET", headers: requestHeaders, timeoutMs: timeoutMs });
    if (response.status === 404) {
      response = await network.request({ url: base + "/vibedraw/v1/capabilities", method: "GET", headers: requestHeaders, timeoutMs: timeoutMs });
    }
    ensureOk(response, requestHeaders);
    var payload = u.parseJson(response.bodyText || "", null);
    return payload && (payload.plugins || payload.tasks) ? payload : null;
  }

  /* 发现文档里那一份任务表。`plugins`(v2.1)与 `tasks`(老 capabilities)两种都给收。 */
  function cvpTaskEntry(payload, task) {
    var list = payload && (payload.plugins || payload.tasks) || [];
    return list.filter(function (item) { return item && item.id === task; })[0] || null;
  }

  /* capabilities 的 `tasks[].model` 是一行文字,`plugins[].model` 是对象 —— 取名字时两种都收。 */
  function cvpEntryModel(entry) {
    var model = entry && entry.model;
    if (typeof model === "string") return model;
    return String(model && model.name || "");
  }

  /* 插件版本号:发现文档放在 `plugin.version`,capabilities 放在顶层 `plugin_version`。 */
  function cvpVersion(payload) {
    if (!payload) return "";
    if (payload.plugin_version) return String(payload.plugin_version);
    return String(payload.plugin && payload.plugin.version || "");
  }

  async function cvpTest(config, requestHeaders) {
    var payload;
    try {
      payload = await cvpDiscovery(config);
    } catch (error) { throw cvpError(error); }
    if (!payload) throw new Error(t("这个地址没有回答 VibeDraw 插件的发现请求,请确认地址指向装有该插件的 ComfyUI(地址通常以 /vibedraw 结尾)",
      "That address did not answer the plugin's discovery request. Check that it points at a ComfyUI with the VibeDraw plugin installed."));
    /* 密码错了这里能说清 —— 发现端点会照常回答,只用 auth.authorized 标明。
       比笼统的"连接失败"有用得多:用户立刻知道该去改密码,而不是去查网络。
       判据必须是"服务器明确说 false",**不能**写成"没说是 true 就当错":v2.0.x 的
       capabilities 里根本没有 authorized 这个字段,那样每个老插件都会被误报成密码错,
       而真正的错因(地址不通、版本不对)反而被藏起来。老插件走的是 401 → cvpError 那条路。 */
    var auth = payload.auth || {};
    if (auth.authorized === false) {
      throw new Error(t("地址已连通,但访问密码不对 —— 请在 ComfyUI 的 VibeDraw 配置节点里核对密码",
        "The address works, but the access password is wrong. Check it in the ComfyUI VibeDraw config node."));
    }
    var wanted = cvpTask(config);
    var entry = cvpTaskEntry(payload, wanted);
    if (!entry) throw new Error(t("插件不支持“" + wanted + "”任务,请升级插件", "The plugin does not offer the " + wanted + " task. Please update it."));
    var model = cvpEntryModel(entry);
    if (!model) throw new Error(t("插件的" + wanted + "任务还没有选择模型,请在 ComfyUI 的 VibeDraw 配置节点里设置", "The plugin has no model for " + wanted + ". Set it in the ComfyUI VibeDraw config node."));
    if (entry.ready === false) throw new Error(t("插件的" + wanted + "任务选好了模型,但机器上找不到那个文件,请在 ComfyUI 的 VibeDraw 配置节点里核对", "The plugin has a model picked for " + wanted + " but its file is not installed. Check the ComfyUI VibeDraw config node."));
    return {
      ok: true, status: 200, task: wanted, model: model,
      sizes: entry.sizes || [], steps: entry.steps || {},
      authRequired: auth.required === true,
      authorized: auth.authorized !== false,
      /* 插件自报的"只认英文"。老插件没有这个字段 → null,调用方就不要去动用户的开关。 */
      englishOnly: typeof entry.english_only === "boolean" ? entry.english_only : null,
      ready: entry.ready !== false,
      version: cvpVersion(payload)
    };
  }

  /* 参考图强度:卡上是 0–200(100 中性),插件要的是 0.05–0.95 的 ref_strength。
     每个任务有自己的基准 —— 渲染的职责是把手上的图放大、不是重新演绎,所以同样
     "100"在渲染卡上比在快速卡上更贴原图;Qwen 的基准是 0.95(参考图原样送进去),
     调低是让插件把原稿柔化,而不是少看一眼。 */
  function refStrength01(config) {
    var limits = app.defaults.limits.refStrength;
    var value = Number(config && config.refStrength);
    if (!isFinite(value) || value <= 0) value = 100;
    value = u.clamp(value, limits[0], limits[1]);
    var base = cvpSpec(cvpTask(config)).refBase;
    return u.clamp(base * (value / 100), 0.05, 0.95);
  }

  function cvpError(error) {
    var text = String(error && error.message || error || "");
    if (/unauthorized|401/.test(text)) return new Error(t("访问密码不正确,请在 ComfyUI 的 VibeDraw 配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI VibeDraw config node."));
    if (/no_model|模型/.test(text)) return new Error(t("插件没有可用模型,请先在 ComfyUI 的 VibeDraw 配置节点里选择 checkpoint", "The plugin has no model. Pick a checkpoint in the ComfyUI VibeDraw config node first."));
    if (/busy|429/.test(text)) return new Error(t("插件队列已满,请稍后再试", "The plugin queue is full. Try again shortly."));
    /* 宿主按 origin 授权局域网访问,没点"允许"之前请求会一直挂着,最后报超时 ——
       这句提示比原样的 "Hermit request timed out" 有用得多。 */
    if (/timed out|E_TIMEOUT/.test(text)) return new Error(t("连不上这个地址:确认手机和服务器在同一局域网,并且已经在宿主弹出的授权框里点了「允许」", "Cannot reach that address. Check that the phone and the server share a network, and that you allowed the host permission prompt."));
    if (/能力已被拒绝|拒绝了此能力|CAPABILITY_DENIED/.test(text)) return new Error(t("网络访问授权被拒绝:请重新「测试连接」,在宿主弹出的确认框里点「允许」", "Network access was denied. Test the connection again and choose Allow in the host prompt."));
    return error;
  }

  async function cvpGenerate(config, input) {
    var base = cvpBase(config.endpoint), api = base + "/vibedraw/v1", task = cvpTask(config);
    var requestHeaders = headers(config, "application/json");
    var value = cvpSize(config);
    var body = {
      task: task,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      seed: Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 9007199254740991),
      size: [value, value],
      steps: Number(config.steps) || cvpSpec(task).steps,
      ref_strength: refStrength01(config)
    };
    if (input.imageDataUrl) body.image_base64 = input.imageDataUrl;
    var label = taskLabel(task);
    app.events.emit("generation:progress", { stage: "submit", detail: t("正在提交" + label + "任务…", "Submitting the " + label + " job…") });
    var submitted;
    try {
      submitted = await network.request({ url: api + "/jobs", method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
      ensureOk(submitted, requestHeaders);
    } catch (error) { throw cvpError(error); }
    var accepted = u.parseJson(submitted.bodyText || "", null), jobId = accepted && accepted.job && accepted.job.id;
    if (!jobId) throw new Error(t("插件未返回任务 ID,请确认插件版本与地址", "The plugin did not return a job id. Check its version and address."));
    var deadline = Date.now() + (Number(config.timeoutMs) || 120000), detail = null;
    while (Date.now() < deadline) {
      await u.sleep(700);
      var polled;
      try {
        polled = await network.request({ url: api + "/jobs/" + encodeURIComponent(jobId), method: "GET", headers: headers(config), timeoutMs: 15000 });
        ensureOk(polled, headers(config));
      } catch (error) { throw cvpError(error); }
      var payload = u.parseJson(polled.bodyText || "", null);
      detail = payload && payload.job;
      if (!detail) continue;
      if (detail.state === "failed") throw new Error(t("插件工作流执行失败:", "The plugin workflow failed: ") + String(detail.error || "unknown"));
      if (detail.state === "cancelled") throw new Error(t("任务已取消", "The job was cancelled"));
      if (detail.state === "completed") break;
      if (detail.progress) app.events.emit("generation:progress", { stage: "running", detail: label + t("进行中…", " in progress…") });
    }
    if (!detail || detail.state !== "completed") throw new Error(t("生成超时,任务可能仍在服务端队列中", "Generation timed out; the job may still be queued on the server"));
    var output = detail.outputs && detail.outputs[0];
    if (!output || !output.url) throw new Error(t("任务完成,但没有图片输出", "The job finished without an image"));
    var imageUrl = /^https?:/i.test(output.url) ? output.url : base + output.url;
    app.events.emit("generation:progress", { stage: "download", detail: t("正在读取生成图片…", "Loading the generated image…") });
    var downloaded;
    try {
      downloaded = await network.request({ url: imageUrl, method: "GET", headers: headers(config), timeoutMs: 60000 });
      ensureOk(downloaded, headers(config));
    } catch (error) { throw cvpError(error); }
    var result = await responseImage(downloaded, headers(config));
    result.metadata = detail;
    return result;
  }

  /* ---------- 出口 ---------- */

  async function generate(config, input) {
    validate(config);
    if (config.protocol === "cvp") return cvpGenerate(config, input);
    if (config.protocol === "openai-images") return openAiGenerate(config, input);
    if (config.protocol === "sd-webui") return sdWebuiGenerate(config, input);
    if (config.protocol === "stability") return stabilityGenerate(config, input);
    throw new Error(t("不支持的图像接口协议:", "Unsupported image API: ") + String(config.protocol || ""));
  }

  function validate(config) {
    if (!config) throw new Error(t("模型配置不存在", "The model config is missing"));
    u.validateEndpoint(config.endpoint);
    var limits = app.defaults.limits;
    var value = Number(config.size);
    if (!(value >= limits.size[0] && value <= limits.size[1])) {
      throw new Error(t("生成分辨率需为 " + limits.size[0] + "–" + limits.size[1], "Use a size between " + limits.size[0] + " and " + limits.size[1]));
    }
    if (config.protocol === "stability" && !config.apiKey && !u.isPrivateHost(new URL(config.endpoint).hostname)) throw new Error(t("请先填写 API Key", "Enter an API key first"));
    if (config.protocol === "openai-images" && !config.model) throw new Error(t("请填写图像模型 ID", "Enter the image model id"));
    u.parseHeaders(config.customHeaders || "");
  }

  /* 测试连接 = 只读一遍对方的自描述,绝不触发生图。
     CVP 那条走发现文档(见 cvpTest),一次回答四件事:地址通不通、密码对不对、
     卡上选的 task 插件认不认、它要不要先译英。 */
  async function test(config) {
    validate(config);
    var requestHeaders = headers(config);
    if (config.protocol === "cvp") return cvpTest(config);
    var root, url;
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
    ensureOk(response, requestHeaders);
    return { ok: true, status: response.status };
  }

  /* 新建一张卡:按协议给一份能直接用的默认值。
     task 取 "quick" / "upscale" / "qwen",决定画幅、步数、超时与参考图基准
     (数值全部来自 app.defaults.cvpTasks)。非 CVP 协议只有"快速/渲染"两种语义,
     所以在别的接口下 task 一律收成这两个 —— 否则从 Qwen 卡切到 SD WebUI 会得到
     一张步数 20、画幅 1024 的怪卡。 */
  function preset(protocol, task) {
    var cvp = protocol === "cvp";
    var wanted = cvp ? cvpTask({ task: task }) : (task === "upscale" ? "upscale" : "quick");
    var spec = cvpSpec(wanted);
    var rendered = wanted === "upscale";
    var value = {
      id: u.id("model"),
      name: taskName(wanted),
      protocol: protocol, task: wanted,
      endpoint: "", apiKey: "", model: "", customHeaders: "",
      size: wanted === "qwen" ? 1024 : (rendered ? 1024 : 512),
      steps: wanted === "qwen" ? spec.steps : 8,
      refStrength: 100,
      growMaskBy: 8,
      quality: rendered ? "high" : "low",
      /* 新建的卡默认不吃英文翻译。字段必须在这里出现,否则"从旧卡切协议"时
         会被整份覆盖掉(见 settings.js 里切协议那段)。 */
      needsEnglish: false,
      timeoutMs: spec.timeoutMs
    };
    if (cvp) {
      /* 空地址对用户没有任何信息量,给一条带 IP 的样例他照着改就行。
         真正显示在表单里的是 settings 那一处(见 renderModelForm),
         这里填的是"这张卡带着的默认值"。 */
      value.endpoint = app.defaults.cvpEndpoint;
    } else if (protocol === "openai-images") {
      value.endpoint = "https://api.openai.com/v1";
      value.model = "gpt-image-1";
      value.size = 1024;
    } else if (protocol === "sd-webui") {
      value.endpoint = "http://192.168.1.2:7860";
      value.steps = rendered ? 28 : 6;
      value.size = rendered ? 1024 : 512;
    } else if (protocol === "stability") {
      value.endpoint = "https://api.stability.ai";
      value.size = 1024;
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
    test: test,
    validate: validate,
    preset: preset,
    byId: byId,
    active: active,
    internals: {
      openAiRoot: openAiRoot,
      cvpBase: cvpBase,
      cvpTask: cvpTask,
      cvpSpec: cvpSpec,
      cvpSize: cvpSize,
      cvpSizeText: cvpSizeText,
      taskName: taskName,
      refStrength01: refStrength01,
      jsonImage: jsonImage,
      side: side
    }
  };
})(window.posegi);
