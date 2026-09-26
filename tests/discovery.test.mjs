/* CVP 的 API 发现(2026-09-26 用户要求)
 *
 * 插件 v2.1 起自报"有哪些任务、各自收什么、要不要先译英",客户端的「测试连接」
 * 由此变成一次真正的读取。这组断言锁三件事,每一件错了都会静默出错图:
 *
 *   1. 优先打 /plugins,老插件(404)退回 /capabilities —— 两条路都要能用。
 *   2. `english_only` 要如实变成 `englishOnly`;老插件没有这个字段时必须给 null,
 *      让界面别去动用户手工拨的开关(猜错方向就会把中文提示词喂给只认英文的编码器)。
 *   3. 地址通但密码错,要和"连不上"分开报 —— 这是发现端点"密码填错也照答"的用处。
 *
 * providers.js 在加载时就把 app.platform.hermit 抓成局部变量,所以宿主替身必须在
 * 加载它**之前**挂上去,这组测试才自己写加载顺序,不复用 providers.test.mjs 的那一段。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;

/* ---------- 宿主替身:按 URL 发预先备好的回答,并记下问过谁 ---------- */
let asked = [];
let routes = {};
app.platform.hermit = {
  request: async (options) => {
    const url = String(options.url);
    asked.push(url);
    const route = routes[url];
    if (!route) return { status: 404, bodyText: "" };
    return { status: route.status, bodyText: JSON.stringify(route.body) };
  },
  httpError: (response) => new Error("HTTP " + response.status)
};

new Function(fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8"))();
const providers = app.services.providers;

const BASE = "http://192.168.1.31:8189/vibedraw";
const PLUGINS_URL = "http://192.168.1.31:8189/vibedraw/v1/plugins";
const CAPS_URL = "http://192.168.1.31:8189/vibedraw/v1/capabilities";

/* 一张 Qwen 卡(能读中文的那条),一张快速卡(只认英文的那条) */
function card(task) {
  const value = providers.preset("cvp", task);
  value.endpoint = BASE;
  value.apiKey = "a1x-vibedraw";
  return value;
}

/* 发现文档的一份最小样本 —— 字段名与插件真实返回的一致 */
function discoveryDoc(entries, options) {
  const settings = options || {};
  return {
    schema: "vibedraw-comfy/discovery/v1",
    api_schema: "vibedraw-comfy/v2",
    plugin: { id: "vibedraw_comfy", version: "2.1.0", label: { zh: "…", en: "…" } },
    auth: { required: true, authorized: settings.authorized !== false, scheme: "Bearer", header: "Authorization" },
    plugins: entries,
    checkpoints: ["DreamShaper8_LCM.safetensors"]
  };
}

const QWEN_ENTRY = {
  id: "qwen", model: { role: "triple", name: "qwen_image_2.1_int8_convrot.safetensors", ready: true },
  english_only: false, prompt_language: "any", ready: true,
  sizes: [[512, 512], [1024, 1024]], steps: { allowed: [12, 20], default: 20 }
};
const QUICK_ENTRY = {
  id: "quick", model: { role: "checkpoint", name: "DreamShaper8_LCM.safetensors", ready: true },
  english_only: true, prompt_language: "en", ready: true,
  sizes: [[512, 512]], steps: { allowed: [2, 4, 6, 8], default: 8 }
};

/* 1) 发现端点优先,而且一次就问对地方 */
{
  asked = [];
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: discoveryDoc([QUICK_ENTRY, QWEN_ENTRY]) };
  const result = await providers.test(card("qwen"));
  assert.deepEqual(asked, [PLUGINS_URL], "有 /plugins 时不该再去问 capabilities");
  assert.equal(result.task, "qwen");
  assert.equal(result.model, "qwen_image_2.1_int8_convrot.safetensors", "模型名要从 model.name 里取");
  assert.equal(result.englishOnly, false, "Qwen 那条能读中文");
  assert.equal(result.version, "2.1.0", "插件版本来自 plugin.version");
  assert.equal(result.ready, true);
  assert.deepEqual(result.sizes, [[512, 512], [1024, 1024]], "画幅档位照抄插件报的那几档");
}

/* 2) `english_only: true` 必须如实传上来 —— 界面靠它决定要不要先译英 */
{
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: discoveryDoc([QUICK_ENTRY, QWEN_ENTRY]) };
  assert.equal((await providers.test(card("quick"))).englishOnly, true, "快速那条只认英文");
}

/* 3) 老插件没有 /plugins:退回 capabilities,并且**不能**凭空断言语言。
      capabilities 的 tasks[].model 是一行文字,取名字也要收得住。 */
{
  asked = [];
  routes = {};
  routes[CAPS_URL] = {
    status: 200,
    body: {
      schema: "vibedraw-comfy/v2", plugin_version: "2.0.1",
      tasks: [{ id: "qwen", model: "qwen_image_2.1_int8_convrot.safetensors", sizes: [[512, 512]], steps: { allowed: [20], default: 20 } }],
      auth: { required: true, scheme: "Bearer" }
    }
  };
  const result = await providers.test(card("qwen"));
  assert.deepEqual(asked, [PLUGINS_URL, CAPS_URL], "404 之后才去问 capabilities");
  assert.equal(result.model, "qwen_image_2.1_int8_convrot.safetensors", "字符串形态的 model 也要取到名字");
  assert.equal(result.englishOnly, null, "老插件不报语言,必须给 null —— 界面据此保留用户的手工开关");
  assert.equal(result.version, "2.0.1", "老插件的版本在顶层 plugin_version");
}

/* 4) 地址通、密码错:要说清是密码的问题,而不是笼统的"连接失败" */
{
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: discoveryDoc([QWEN_ENTRY], { authorized: false }) };
  let message = "";
  try { await providers.test(card("qwen")); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("访问密码不对") >= 0, `密码错要单独说清,收到:${message}`);
  assert.ok(message.indexOf("已连通") >= 0, `还要说明地址是通的,收到:${message}`);
}

/* 5) 卡上的任务插件不认(老插件只有三套,没有 Qwen):要提示升级,不是发出去再 400 */
{
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: discoveryDoc([QUICK_ENTRY]) };
  let message = "";
  try { await providers.test(card("qwen")); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("请升级插件") >= 0, `任务不在册要提示升级,收到:${message}`);
}

/* 6) 任务在册但模型文件没装:ready 要拦住 —— 否则提交时才被 409 顶回来 */
{
  const broken = JSON.parse(JSON.stringify(QWEN_ENTRY));
  broken.ready = false;
  broken.model.ready = false;
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: discoveryDoc([broken]) };
  let message = "";
  try { await providers.test(card("qwen")); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("找不到") >= 0, `模型没装要说清,收到:${message}`);
}

/* 7) 地址根本不是这个插件:要说是地址的问题,别假装密码错 */
{
  routes = {};
  routes[PLUGINS_URL] = { status: 200, body: { hello: "world" } };
  routes[CAPS_URL] = { status: 200, body: { hello: "world" } };
  let message = "";
  try { await providers.test(card("qwen")); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("发现请求") >= 0, `不是插件要说清是地址问题,收到:${message}`);
}

/* 8) 非 CVP 协议不走发现 —— 别把别的服务也拿去问 /plugins */
{
  asked = [];
  routes = {};
  routes["http://192.168.1.31:7860/sdapi/v1/sd-models"] = { status: 200, body: [] };
  const sd = providers.preset("sd-webui", "quick");
  sd.endpoint = "http://192.168.1.31:7860";
  const result = await providers.test(sd);
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ["http://192.168.1.31:7860/sdapi/v1/sd-models"], "SD WebUI 还是问它自己的模型列表");
}

console.log("discovery.test.mjs: ok (发现端点优先、老插件退回、语言如实上报、密码与地址分开报)");
