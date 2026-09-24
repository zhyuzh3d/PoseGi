/* 生图接口适配:把统一请求翻译成各家本地服务的协议
 *
 * 责任:只做协议翻译,不做编排、不做重试、不读 app.state。
 * 约定:每个适配器实现两个方法
 *   build(job)  → { url, method, headers, bodyText|bodyBytes, timeoutMs }
 *   parse(data) → { imageBase64, mime }
 *
 * job 形状(由 image-engine 组装):
 *   { protocol, endpoint, apiKey, model, customHeaders, prompt, negativePrompt,
 *     steps, strength, guidanceScale, width, height, imageBase64, mime, timeoutMs }
 *
 * 现状:这里只有协议清单与调用契约,三个适配器都还没实现。
 * 选型说明:
 *   - sdwebui 最省事:一次 POST /sdapi/v1/img2img,参考图直接放 init_images。
 *   - comfyui 能力最强但需要一份工作流 JSON,并轮询 /history 取图。
 *   - openai 需要 multipart 上传参考图,先确认桥接层的二进制上传能力再动。
 */
(function (app) {
  "use strict";

  function todo(name) {
    return function () { throw new Error(name + " 适配尚未实现"); };
  }

  var ADAPTERS = {
    sdwebui: {
      name: "Stable Diffusion WebUI / Forge",
      fields: ["endpoint", "apiKey", "customHeaders", "steps", "strength", "guidanceScale"],
      build: todo("Stable Diffusion WebUI / Forge"),
      parse: todo("Stable Diffusion WebUI / Forge")
    },
    comfyui: {
      name: "ComfyUI(需要工作流)",
      fields: ["endpoint", "apiKey", "customHeaders", "workflow"],
      build: todo("ComfyUI"),
      parse: todo("ComfyUI")
    },
    openai: {
      name: "OpenAI Images 兼容",
      fields: ["endpoint", "apiKey", "model"],
      build: todo("OpenAI Images 兼容"),
      parse: todo("OpenAI Images 兼容")
    }
  };

  function list() {
    return Object.keys(ADAPTERS).map(function (id) {
      return { id: id, name: ADAPTERS[id].name, fields: ADAPTERS[id].fields.slice() };
    });
  }

  function byId(id) { return ADAPTERS[id] || null; }

  function build(job) {
    var adapter = byId(job && job.protocol);
    if (!adapter) throw new Error("未知的生图接口:" + String(job && job.protocol || ""));
    return adapter.build(job);
  }

  function parse(protocol, data) {
    var adapter = byId(protocol);
    if (!adapter) throw new Error("未知的生图接口:" + String(protocol || ""));
    return adapter.parse(data);
  }

  app.services.providers = { list: list, byId: byId, build: build, parse: parse };
})(window.posegi);
