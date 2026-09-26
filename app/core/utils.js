/* 通用工具:纯函数,无副作用,不依赖 DOM 与宿主
 *
 * 约束:只用保守语法(兼容旧 WebView)。禁用可选链、空值合并与逻辑赋值运算符。
 */
(function (app) {
  "use strict";

  /* 界外值回落到下界 —— 这是 PoseGi 一直以来的口径(角度、行程都靠它兜底) */
  function clamp(value, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function copy(value) { return JSON.parse(JSON.stringify(value)); }

  function id(prefix) { return String(prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function stripSlash(value) { return String(value || "").replace(/\/+$/, ""); }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  /* 把任意角度归一化到 (-180, 180],便于比较与落盘 */
  function normalizeAngle(degrees) {
    var value = Number(degrees);
    if (!isFinite(value)) return 0;
    value = value % 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    /* + 0 把 -0 折叠成 0:负零会让姿态比对与落盘结果出现无意义的差异 */
    return Math.round(value * 10) / 10 + 0;
  }

  function parseJson(text, fallback) {
    if (typeof text !== "string" || !text) return fallback;
    try {
      var value = JSON.parse(text);
      return value === null || value === undefined ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  /* 把异常变成可直接展示的一行,不泄露密钥 */
  function cleanError(error) {
    var message = error && error.message ? String(error.message) : String(error || "未知错误");
    return message
      .replace(/Bearer\s+[^\s]+/gi, "Bearer ***")
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "***")
      .replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function isPrivateHost(host) {
    var value = String(host || "").toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "10.0.2.2" ||
      /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /\.local$/.test(value);
  }

  /* 请求地址校验:公网必须 HTTPS,HTTP 只允许可信局域网与本机回环 */
  function validateEndpoint(url) {
    var value = String(url || "").trim();
    if (!value) throw new Error("请先填写生图服务地址");
    if (!/^https?:\/\//i.test(value)) throw new Error("地址必须以 http:// 或 https:// 开头");
    var parsed;
    try { parsed = new URL(value); } catch (error) { throw new Error("地址不是完整的 URL:" + value.slice(0, 80)); }
    if (parsed.username || parsed.password) throw new Error("地址里不要带账号密码");
    if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
      throw new Error("公网地址必须使用 HTTPS,HTTP 只允许可信局域网地址");
    }
    return value;
  }

  /* 自定义请求头:必须是 JSON 对象,不许改 Host / Content-Length */
  function parseHeaders(text) {
    if (!String(text || "").trim()) return {};
    var value = parseJson(text, null);
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw new Error("自定义请求头必须是 JSON 对象");
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error("请求头名称不合法:" + key);
      if (/^(host|content-length)$/i.test(key)) throw new Error("不能自定义 " + key + " 请求头");
      result[key] = String(value[key]);
    });
    return result;
  }

  /* 深合并:配置里嵌套的对象(connection / preferences / limits)必须逐层合并,
     浅合并会让"旧版本存下来的配置缺一个子字段"直接把整块默认值顶掉。 */
  function merge(target, source) {
    var output = {};
    var key;
    for (key in target) if (Object.prototype.hasOwnProperty.call(target, key)) output[key] = target[key];
    for (key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      var value = source[key];
      if (value && Object.prototype.toString.call(value) === "[object Object]" &&
        output[key] && Object.prototype.toString.call(output[key]) === "[object Object]") {
        output[key] = merge(output[key], value);
      } else {
        output[key] = value;
      }
    }
    return output;
  }

  function bytesToBase64(bytes) {
    var chunk = 0x8000, parts = [];
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var index = 0; index < view.length; index += chunk) {
      parts.push(String.fromCharCode.apply(null, view.subarray(index, index + chunk)));
    }
    return btoa(parts.join(""));
  }

  function base64ToBytes(text) {
    var binary = atob(String(text || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function utf8Bytes(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(String(value));
    var encoded = unescape(encodeURIComponent(String(value))), bytes = new Uint8Array(encoded.length);
    for (var index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }

  /* 按 UTF-8 字节数算长度:分块存储的上限是字节,不是字符 */
  function utf8Length(value) {
    var text = String(value || ""), length = 0;
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code < 0x80) length += 1;
      else if (code < 0x800) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { length += 4; index += 1; }
      else length += 3;
    }
    return length;
  }

  /* 按字节上限切字符串,且不切断任何一个码点(切坏了 JSON.parse 会整体失败) */
  function utf8Chunks(value, maximumBytes) {
    var text = String(value || ""), limit = Math.max(1024, Number(maximumBytes) || 48000), chunks = [], start = 0, bytes = 0;
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      var size = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff ? 4 : 3;
      if (bytes && bytes + size > limit) { chunks.push(text.slice(start, index)); start = index; bytes = 0; }
      bytes += size;
      if (size === 4) index += 1;
    }
    if (start < text.length || !chunks.length) chunks.push(text.slice(start));
    return chunks;
  }

  function concatBytes(parts) {
    var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var output = new Uint8Array(total), offset = 0;
    parts.forEach(function (part) { output.set(part, offset); offset += part.length; });
    return output;
  }

  function dataUrlParts(dataUrl) {
    var match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!match) throw new Error("截图格式异常,不是可用的 data URL");
    return { mime: match[1] || "image/png", base64: match[2], bytes: base64ToBytes(match[2]) };
  }

  function dataUrlByteLength(dataUrl) {
    var value = String(dataUrl || ""), comma = value.indexOf(",");
    var base64 = comma >= 0 ? value.slice(comma + 1) : value;
    var padding = /==$/.test(base64) ? 2 : /=$/.test(base64) ? 1 : 0;
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  /* multipart/form-data 的字节组装:参考图必须走二进制,不能走 JSON+base64,
     否则一次请求的字符数会翻掉三分之一(见 platform/hermit.js 的消息上限)。 */
  function multipart(fields, files) {
    var boundary = "----PoseGi" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    var chunks = [];
    Object.keys(fields || {}).forEach(function (name) {
      var value = fields[name];
      if (value === null || value === undefined || value === "") return;
      chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + String(value) + "\r\n"));
    });
    (files || []).forEach(function (file) {
      chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + file.name + "\"; filename=\"" + (file.filename || "image.png") + "\"\r\nContent-Type: " + (file.mime || "image/png") + "\r\n\r\n"));
      chunks.push(file.bytes);
      chunks.push(utf8Bytes("\r\n"));
    });
    chunks.push(utf8Bytes("--" + boundary + "--\r\n"));
    return { bytes: concatBytes(chunks), contentType: "multipart/form-data; boundary=" + boundary };
  }

  function imageMimeFromHeaders(headers, fallback) {
    var keys = Object.keys(headers || {}), type = "";
    keys.some(function (name) { if (name.toLowerCase() === "content-type") { type = headers[name]; return true; } return false; });
    type = String(type || fallback || "image/png").split(";")[0].trim();
    return /^image\//.test(type) ? type : "image/png";
  }

  function composePrompt(globalPrompt, localPrompt) {
    var global = String(globalPrompt === null || globalPrompt === undefined ? "" : globalPrompt).trim().replace(/[,\s]+$/, "");
    var local = String(localPrompt === null || localPrompt === undefined ? "" : localPrompt).trim().replace(/^[,\s]+/, "");
    if (!local) return global;
    if (!global) return local;
    return global + ", " + local;
  }

  function formatTime(value) {
    var date = new Date(Number(value) || Date.now());
    function pad(number) { return (number < 10 ? "0" : "") + number; }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  app.utils = {
    clamp: clamp,
    copy: copy,
    id: id,
    sleep: sleep,
    stripSlash: stripSlash,
    escapeHtml: escapeHtml,
    normalizeAngle: normalizeAngle,
    parseJson: parseJson,
    cleanError: cleanError,
    isPrivateHost: isPrivateHost,
    validateEndpoint: validateEndpoint,
    parseHeaders: parseHeaders,
    merge: merge,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    utf8Bytes: utf8Bytes,
    utf8Length: utf8Length,
    utf8Chunks: utf8Chunks,
    concatBytes: concatBytes,
    dataUrlParts: dataUrlParts,
    dataUrlByteLength: dataUrlByteLength,
    multipart: multipart,
    imageMimeFromHeaders: imageMimeFromHeaders,
    composePrompt: composePrompt,
    formatTime: formatTime
  };
})(window.posegi);
