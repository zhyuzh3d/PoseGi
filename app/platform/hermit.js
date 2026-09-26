/* 宿主 Bridge 与网络的唯一出口
 *
 * 责任:把 window.hermit 的能力包成稳定接口,并在没有宿主时退回浏览器实现。
 * 约束:任何模块都不许直接调用 window.hermit 或 fetch,一律经这里。
 *
 * 宿主消息上限:单条消息超过 256 KiB 会被静默丢弃,调用方只会等到自己的超时。
 * 因此所有内联请求体都控制在 MESSAGE_CHARS 以内(图片走文件接口或分块)。
 */
(function (app) {
  "use strict";

  var ready = false;
  var waiters = [];
  var MESSAGE_CHARS = 200000;
  var DATA_PREFIX = "posegi:";

  function current() { return window.hermit && window.hermit.isReady ? window.hermit : null; }

  function markReady() {
    if (!current()) return;
    ready = true;
    waiters.splice(0).forEach(function (resolve) { resolve(true); });
    app.events.emit("platform:ready", true);
  }

  window.addEventListener("hermitready", markReady);
  if (current()) markReady();

  function awaitReady(timeoutMs) {
    if (ready || current()) { markReady(); return Promise.resolve(true); }
    return new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (done) return; done = true; resolve(value); }
      waiters.push(finish);
      setTimeout(function () {
        waiters = waiters.filter(function (item) { return item !== finish; });
        finish(Boolean(current()));
      }, typeof timeoutMs === "number" ? timeoutMs : 1200);
    });
  }

  function available() { return Boolean(current()); }

  function checkBudget(options) {
    var size = typeof options.bodyText === "string" ? options.bodyText.length
      : options.bodyBytes ? Math.ceil(options.bodyBytes.length / 3) * 4 : 0;
    if (size <= MESSAGE_CHARS) return;
    throw new Error("这次要发送的数据有 " + Math.round(size / 1024) + " KB,超过宿主单次请求上限,请减小图片尺寸后重试");
  }

  /* 网络授权:宿主按 origin 授权,没授权的 origin 第一次访问时它会弹一个原生确认框,
     用户点"允许"之前请求一直挂着 —— 表现是 60 秒后报 "Hermit request timed out",
     看起来像"设备连不上",其实什么都没发出去(2026-09-25 真机踩到过,见当日记忆)。
     所以正式发请求之前显式要一次授权,弹框就落在用户刚点按钮的那一刻。
     授权是按 origin 记的,同一个地址只弹一次;失败的(用户拒绝)不记,下次再问。 */
  var authorizedOrigins = {};

  async function authorizeNetwork(url) {
    var bridge = current();
    if (!bridge || !bridge.permissions || typeof bridge.permissions.request !== "function") return false;
    var origin;
    try { origin = new URL(url).origin; } catch (error) { return false; }
    if (authorizedOrigins[origin]) return true;
    try {
      await bridge.permissions.request({ capability: "network", scope: origin });
      authorizedOrigins[origin] = true;
      return true;
    } catch (error) {
      return false;
    }
  }

  /* 网络请求:宿主可用时走原生网络,否则退回 fetch(仅开发用) */
  async function request(options) {
    app.utils.validateEndpoint(options.url);
    checkBudget(options);
    var headers = options.headers || {};
    if (current() || await awaitReady(800)) {
      await authorizeNetwork(options.url);
      var params = {
        url: options.url,
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        timeoutMs: Number(options.timeoutMs) || 60000
      };
      if (options.bodyBytes) {
        params.bodyBase64 = app.utils.bytesToBase64(options.bodyBytes);
        params.contentType = options.contentType || "application/octet-stream";
      } else if (typeof options.bodyText === "string") {
        params.bodyText = options.bodyText;
        params.contentType = options.contentType || "application/json";
      }
      return current().network.request(params);
    }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, Number(options.timeoutMs) || 60000) : null;
    try {
      var response = await fetch(options.url, {
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        body: options.bodyBytes || options.bodyText,
        signal: controller ? controller.signal : undefined
      });
      var responseHeaders = {};
      response.headers.forEach(function (value, name) { responseHeaders[name] = value; });
      var type = response.headers.get("content-type") || "application/octet-stream";
      if (/json|text|xml/i.test(type)) {
        return { status: response.status, headers: responseHeaders, url: response.url, bodyText: await response.text() };
      }
      var buffer = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: responseHeaders, url: response.url, bodyBase64: app.utils.bytesToBase64(buffer) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function httpError(response, payload, headers) {
    var detail = payload && (payload.error || payload.detail || payload.message) || response.bodyText || "服务未返回可读错误";
    if (detail && typeof detail === "object") detail = detail.message || detail.code || JSON.stringify(detail);
    Object.keys(headers || {}).forEach(function (name) {
      if (!/authorization|key|token|secret/i.test(name)) return;
      var secret = String(headers[name] || "").replace(/^Bearer\s+/i, "");
      if (secret.length > 3) detail = String(detail).split(secret).join("***");
    });
    var category = response.status === 401 ? "认证失败"
      : response.status === 403 ? "权限不足"
        : response.status === 429 ? "额度或频率限制"
          : response.status >= 500 ? "服务端错误" : "请求失败";
    var error = new Error(category + "(" + response.status + "):" + String(detail).slice(0, 300));
    error.status = response.status;
    return error;
  }

  async function requestJson(options) {
    var response = await request(options);
    var payload = app.utils.parseJson(response.bodyText || "", null);
    if (response.status < 200 || response.status >= 300) throw httpError(response, payload, options.headers);
    if (!payload) throw new Error("服务返回的不是有效 JSON");
    return { response: response, data: payload };
  }

  /* 数据持久化:happ 隔离数据区,浏览器下降级到 localStorage */
  function storageKey(collection, key) { return DATA_PREFIX + collection + ":" + key; }

  async function getData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.get({ collection: collection, key: key });
    var stored = localStorage.getItem(storageKey(collection, key));
    return stored ? { collection: collection, key: key, value: app.utils.parseJson(stored, null), revision: "browser" } : null;
  }

  async function putData(collection, key, value, expectedRevision) {
    if (current() || await awaitReady(800)) {
      var params = { collection: collection, key: key, value: value };
      if (expectedRevision) params.expectedRevision = expectedRevision;
      return current().data.put(params);
    }
    localStorage.setItem(storageKey(collection, key), JSON.stringify(value));
    return { collection: collection, key: key, value: value, revision: "browser" };
  }

  async function deleteData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.delete({ collection: collection, key: key });
    localStorage.removeItem(storageKey(collection, key));
    return { deleted: true };
  }

  /* 选图:返回 { logicalFileId, base64, mime, name } 或 null */
  async function pickImage() {
    if (current() || await awaitReady(500)) return current().files.pickImage({ maxDimension: 2048, maxBytes: 12 * 1024 * 1024 });
    return null;
  }

  async function clipboardRead() {
    if (current() || await awaitReady(500)) {
      var result = await current().clipboard.read();
      return String(result && result.text || "");
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.readText();
    throw new Error("当前环境不能读取剪贴板,请长按输入框粘贴");
  }

  /* 把视口截图存成一张真的图片文件,并把系统的「保存图片 / 保存到…」对话框拉起来。
   *
   * 为什么不能一步塞给 files.import:一张 1024 的 PNG 的 dataURL 有 230 KB 上下,
   * 一次桥消息装不下(宿主 256 KiB 与自家 MESSAGE_CHARS 都会拦),所以走
   * beginWrite → appendBytes(每次 ≤64 KiB)→ finishWrite 这条分块通道。
   * 真正的"拉起保存"是最后那一下 files.export:它由宿主弹系统文件选择框,
   * 用户可以存进相册 / 下载 / 任意目录 —— 那是宿主的能力,页面做不到。
   *
   * 浏览器开发环境没有宿主:直接给一个下载链接,行为对齐。 */
  async function saveImage(shot, name) {
    var bridge = current() || (await awaitReady(800) ? current() : null);
    var parts = app.utils.dataUrlParts(shot && shot.dataUrl);
    var fileName = String(name || "").trim() || ("posegi-" + Date.now() + ".png");
    if (!bridge) {
      var link = document.createElement("a");
      link.href = shot.dataUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return { exported: true, logicalFileId: "", name: fileName, bytes: parts.bytes.length, fallback: true };
    }
    var handle = await bridge.files.beginWrite({ name: fileName, mime: parts.mime || "image/png" });
    var chunk = Math.max(4096, Math.min(Number(handle.maxChunkBytes) || 65536, 65536));
    var committed = false;
    try {
      for (var offset = 0; offset < parts.bytes.length; offset += chunk) {
        await bridge.files.appendBytes({
          writeId: handle.writeId,
          chunkBase64: app.utils.bytesToBase64(parts.bytes.subarray(offset, offset + chunk))
        });
      }
      var stored = await bridge.files.finishWrite({ writeId: handle.writeId });
      committed = true;
      var logicalFileId = String(stored && stored.logicalFileId || "");
      var outcome = await bridge.files.export({ logicalFileId: logicalFileId });
      return {
        exported: Boolean(outcome && outcome.exported),
        cancelled: Boolean(outcome && outcome.cancelled),
        logicalFileId: logicalFileId,
        name: fileName,
        bytes: parts.bytes.length
      };
    } finally {
      /* 只有"还没提交"才中止 —— 提交过之后句柄已经不在宿主的未完成表里了,
         再 abort 只会得到一句"写入句柄不存在",把真正的错误盖掉。 */
      if (!committed) await bridge.files.abortWrite({ writeId: handle.writeId }).catch(function () {});
    }
  }

  async function reportTheme() {
    if (!(current() || await awaitReady(500))) return;
    /* 应用恒定深色(app.THEME),不再按系统偏好上报 —— 否则宿主外壳会按亮色画状态栏 */
    var theme = app.THEME === "light" ? "light" : "dark";
    await current().appearance.reportTheme({ theme: theme }).catch(function () {});
  }

  async function appReady() {
    if (current() || await awaitReady(1000)) await current().app.ready().catch(function () {});
  }

  app.platform.hermit = {
    messageChars: MESSAGE_CHARS,
    current: current,
    available: available,
    awaitReady: awaitReady,
    authorizeNetwork: authorizeNetwork,
    request: request,
    requestJson: requestJson,
    httpError: httpError,
    getData: getData,
    putData: putData,
    deleteData: deleteData,
    pickImage: pickImage,
    saveImage: saveImage,
    clipboardRead: clipboardRead,
    reportTheme: reportTheme,
    appReady: appReady
  };
})(window.posegi);
