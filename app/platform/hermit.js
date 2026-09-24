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

  /* 网络请求:宿主可用时走原生网络,否则退回 fetch(仅开发用) */
  async function request(options) {
    app.utils.validateEndpoint(options.url);
    checkBudget(options);
    var headers = options.headers || {};
    if (current() || await awaitReady(800)) {
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

  async function reportTheme() {
    if (!(current() || await awaitReady(500))) return;
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    await current().appearance.reportTheme({ theme: dark ? "dark" : "light" }).catch(function () {});
  }

  async function appReady() {
    if (current() || await awaitReady(1000)) await current().app.ready().catch(function () {});
  }

  app.platform.hermit = {
    messageChars: MESSAGE_CHARS,
    current: current,
    available: available,
    awaitReady: awaitReady,
    request: request,
    requestJson: requestJson,
    httpError: httpError,
    getData: getData,
    putData: putData,
    deleteData: deleteData,
    pickImage: pickImage,
    clipboardRead: clipboardRead,
    reportTheme: reportTheme,
    appReady: appReady
  };
})(window.posegi);
