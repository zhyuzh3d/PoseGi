/* 图片资产:把 data URL 落成宿主文件,记录里只留引用
 *
 * 责任:data URL ⇄ 文件句柄的转换,以及"哪些文件还被谁引用"的清理。
 * 约束:图片字节与 Base64 一律不进 hermit.data(见 AGENTS.md)——
 *       记录里只存 logicalFileId 数组,图片本体以文本块的形式存在宿主文件区。
 *
 * 为什么分块:宿主的文件接口是**文本**写入,一次能带多少有上限,
 * 所以把 base64 切成 180000 字符一块,每块一个文件;读回时按同样顺序拼起来。
 * 缓存键就是那串 logicalFileId,内容一样就不重复读盘(成图缩略图会被反复打开)。
 */
(function (app) {
  "use strict";

  var cache = app.runtime.createLru({
    maxEntries: 12,
    maxWeight: 32 * 1024 * 1024,
    weight: function (value) { return typeof value === "string" ? value.length * 2 : 1; }
  });
  var inFlight = new Map();
  var CHUNK = 180000;

  function persist(src, existing) {
    if (existing) return Promise.resolve(existing);
    if (!src) return Promise.resolve(null);
    if (String(src).indexOf("data:") !== 0) return Promise.resolve({ url: src });
    if (inFlight.has(src)) return inFlight.get(src);
    var bridge = app.platform.hermit.current();
    if (!bridge) return Promise.reject(new Error(app.i18n.text("保存图片需要在 Hermit 中打开应用", "Open in Hermit to save images")));
    var parts = app.utils.dataUrlParts(src);
    if (!/^image\/(png|jpeg|webp)$/.test(parts.mime) || app.utils.dataUrlByteLength(src) > 12 * 1024 * 1024) {
      return Promise.reject(new Error(app.i18n.text("图片最大支持 12 MB 的 PNG、JPEG 或 WebP", "Use PNG, JPEG or WebP images up to 12 MB")));
    }
    var pending = (function () {
      var refs = [], value = parts.base64, name = app.utils.id("asset");
      return (async function () {
        try {
          for (var offset = 0; offset < value.length; offset += CHUNK * 4) {
            var tasks = [];
            for (var cursor = offset, position = refs.length; cursor < Math.min(value.length, offset + CHUNK * 4); cursor += CHUNK, position += 1) {
              (function (partOffset, partPosition) {
                tasks.push(bridge.files.writeText({ name: name + "-" + partPosition + ".pgi", text: value.slice(partOffset, partOffset + CHUNK) }).then(function (file) {
                  refs[partPosition] = file.logicalFileId;
                  return null;
                }, function (error) { return error; }));
              })(cursor, position);
            }
            var errors = (await Promise.all(tasks)).filter(function (error) { return Boolean(error); });
            if (errors.length) throw errors[0];
          }
          var asset = { mime: parts.mime, parts: refs };
          cache.set(refs.join(","), src);
          return asset;
        } catch (error) {
          await Promise.all(refs.map(function (logicalFileId) {
            return logicalFileId ? bridge.files.delete({ logicalFileId: logicalFileId }).catch(function () {}) : Promise.resolve();
          }));
          throw error;
        }
      })();
    })();
    inFlight.set(src, pending);
    return pending.then(function (value) { inFlight.delete(src); return value; }, function (error) { inFlight.delete(src); throw error; });
  }

  async function resolve(asset) {
    if (!asset) return "";
    if (asset.url) return String(asset.url);
    var key = (asset.parts || []).join(",");
    var cached = cache.get(key);
    if (cached) return cached;
    var bridge = app.platform.hermit.current(), values = new Array((asset.parts || []).length);
    if (!bridge) throw new Error(app.i18n.text("恢复图片需要 Hermit", "Hermit is required to restore images"));
    for (var index = 0; index < asset.parts.length; index += 4) {
      var tasks = [];
      for (var position = index; position < Math.min(asset.parts.length, index + 4); position += 1) {
        (function (partPosition) {
          tasks.push(bridge.files.readText({ logicalFileId: asset.parts[partPosition], maxBytes: 200000 }).then(function (part) { values[partPosition] = part.text; }));
        })(position);
      }
      await Promise.all(tasks);
    }
    if (!/^image\/(png|jpeg|webp)$/.test(asset.mime) || !values.every(function (value) { return /^[A-Za-z0-9+/=]+$/.test(value); })) {
      throw new Error(app.i18n.text("历史图片数据损坏", "Saved image data is damaged"));
    }
    var src = "data:" + asset.mime + ";base64," + values.join("");
    cache.set(key, src);
    return src;
  }

  function references(snapshot) {
    var refs = [];
    if (!snapshot) return refs;
    var items = (snapshot.results || []).slice();
    if (snapshot.result) items.push(snapshot.result);
    items.forEach(function (item) {
      if (item && item.asset && item.asset.parts) refs = refs.concat(item.asset.parts);
      if (item && item.logicalFileId) refs.push(item.logicalFileId);
    });
    return refs;
  }

  async function cleanup(removed, remaining) {
    var used = {};
    (remaining || []).forEach(function (snapshot) {
      references(snapshot).forEach(function (id) { used[id] = true; });
    });
    var bridge = app.platform.hermit.current();
    if (!bridge) return;
    var unique = {};
    references(removed).forEach(function (id) { if (!used[id]) unique[id] = true; });
    var ids = Object.keys(unique);
    for (var offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(function (id) {
        return bridge.files.delete({ logicalFileId: id }).catch(function () {});
      }));
    }
    cache.keys().forEach(function (key) {
      if (key.split(",").some(function (id) { return unique[id]; })) cache.delete(key);
    });
  }

  function clearCache() { cache.clear(); }

  app.services.assets = {
    persist: persist,
    resolve: resolve,
    references: references,
    cleanup: cleanup,
    clearCache: clearCache
  };
})(window.posegi);
