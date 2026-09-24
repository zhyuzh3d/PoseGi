/* 通用工具:纯函数,无副作用,不依赖 DOM 与宿主
 *
 * 约束:只用保守语法(兼容旧 WebView)。禁用可选链、空值合并与逻辑赋值运算符。
 */
(function (app) {
  "use strict";

  function clamp(value, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
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

  /* 把异常变成可直接展示的一行中文,不泄露密钥 */
  function cleanError(error) {
    var message = error && error.message ? String(error.message) : String(error || "未知错误");
    return message.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  /* 请求地址校验:公网必须 HTTPS,HTTP 只允许可信局域网与本机回环 */
  function validateEndpoint(url) {
    var value = String(url || "").trim();
    if (!value) throw new Error("请先填写生图服务地址");
    if (/^https:\/\//i.test(value)) return value;
    if (!/^http:\/\//i.test(value)) throw new Error("地址必须以 http:// 或 https:// 开头");
    var host = value.replace(/^http:\/\//i, "").split("/")[0].split(":")[0];
    var lan = /^10\./.test(host) || /^192\.168\./.test(host) || /^127\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || host === "localhost";
    if (!lan) throw new Error("公网地址必须使用 HTTPS,HTTP 只允许可信局域网地址");
    return value;
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
    var binary = atob(String(text || ""));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function merge(base, patch) {
    var result = {};
    var key;
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
    for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) result[key] = patch[key];
    return result;
  }

  function formatTime(value) {
    var date = new Date(Number(value) || Date.now());
    function pad(number) { return (number < 10 ? "0" : "") + number; }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  app.utils = {
    clamp: clamp,
    normalizeAngle: normalizeAngle,
    parseJson: parseJson,
    cleanError: cleanError,
    validateEndpoint: validateEndpoint,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    merge: merge,
    formatTime: formatTime
  };
})(window.posegi);
