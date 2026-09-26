/* 模型卡表单的读写闭环
 *
 * 锁的是一个"不报错、但白干"的 bug(2026-09-26 用户报的「保存无效,打开又是空的」):
 *   CVP 的地址 / 密码 / 请求头在配置里**只有一份**,住在 config.connection 上,
 *   由 store.shareCvp 分发到每一张 cvp 卡。而表单只能把值写进编辑期间的草稿 ——
 *   如果 saveModel 忘了把它回写到 config.connection,shareCvp 紧接着就会拿旧的
 *   空 connection 把所有 cvp 卡的地址覆盖成空。
 *   症状:填好地址保存,重新打开又是空的;而且不抛错、不报日志。
 *
 * 这组测试走的是真实的 settings 表单路径(openAddModel / openModels 的编辑按钮),
 * 不是把 saveModel 抠出来单测 —— 因为 bug 恰恰出在"表单读到的值没人往配置里搬"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};

const CORE = ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/providers.js", "app/services/store.js"];
for (const file of CORE) new Function(fs.readFileSync(path.join(root, file), "utf8"))();

const app = globalThis.window.posegi;
const store = app.services.store;
app.components = app.components || {};
/* settings.js 依赖 app.components 已经存在,所以它自己单独加载 */
new Function(fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8"))();

/* ---------- 宿主替身:数据区在内存里,不该发网络请求 ---------- */
const mem = new Map();
app.platform.hermit = {
  getData: async (collection, key) => {
    const name = collection + "/" + key;
    return mem.has(name) ? { collection, key, value: mem.get(name) } : null;
  },
  /* 走一遍序列化,把 undefined 与函数剥掉 —— 真机存进数据区的也就这些 */
  putData: async (collection, key, value) => {
    const stored = JSON.parse(JSON.stringify(value));
    mem.set(collection + "/" + key, stored);
    return { collection, key, value: stored };
  },
  deleteData: async (collection, key) => { mem.delete(collection + "/" + key); return { deleted: true }; },
  request: async () => { throw new Error("这组测试不该发网络请求"); }
};

/* ---------- 表单替身 ----------
   settings 对表单只做两件事:.value 读写,以及给按钮赋 onclick。
   所以替身只认 [name=...] 与几个 data- 钩子就够了,不必真的解析 HTML。 */
let fieldValues = {};
let editIds = [];
let lastForm = null;
let lastBody = "";

function makeForm() {
  const nodes = {};
  Object.keys(fieldValues).forEach((key) => {
    nodes[key] = { value: fieldValues[key], type: "text", dataset: {} };
  });
  const hooks = {};
  /* 这份按钮数组必须在同一个表单内保持不变 —— onMount 给它们赋 onclick,
     之后测试再取一次来点。每次都新建的话,点到的是另一个对象,onclick 是空的。 */
  const editButtons = editIds.map((id) => ({ dataset: { edit: id }, onclick: null }));
  return {
    nodes,
    querySelector(selector) {
      const named = /^\[name="([^"]+)"\]$/.exec(selector);
      if (named) return nodes[named[1]] || null;
      /* 密钥框上的两个按钮不绑定,省掉剪贴板依赖 */
      if (selector === "[data-toggle-secret]" || selector === "[data-paste-secret]") return null;
      if (selector === "[data-add]") return null;
      if (!hooks[selector]) {
        hooks[selector] = { dataset: {}, textContent: "", classList: { add() {}, remove() {} }, setAttribute() {} };
      }
      return hooks[selector];
    },
    querySelectorAll(selector) {
      if (selector === 'input[type="range"]') return [];
      if (selector === "[data-edit]") return editButtons;
      return [];
    }
  };
}

const toasts = [];
/* saveModel 从 document 里取当前弹窗内容,所以这个替身也要在 */
globalThis.document = { getElementById: (id) => (id === "modal-content" ? lastForm : null) };
app.components.ui = {
  openSheet(options) {
    const form = makeForm();
    lastForm = form;
    lastBody = options.bodyHtml || "";
    if (typeof options.onMount === "function") options.onMount(form);
    return form;
  },
  closeSheet() {},
  toast(message) { toasts.push(message); },
  action(fn) { return fn; },
  confirm: async () => true
};

/* ---------- 用例 ---------- */

const VIBE_ENDPOINT = "http://192.168.124.31:8189/vibedraw";
const VIBE_PASSWORD = "a1x-vibedraw";

await store.loadConfig();
assert.ok(app.config.models.length >= 3, "出厂应该有几张模型卡");

/* 1) 新建一张 CVP 卡,填上地址与密码,保存后**配置里必须真的有**。
      修复前:config.connection 还是空的,shareCvp 反手把刚填的地址清掉。 */
fieldValues = {
  name: "家里的 CVP", protocol: "cvp",
  endpoint: VIBE_ENDPOINT, apiKey: VIBE_PASSWORD, customHeaders: "",
  size: "512", refStrength: "100", steps: "8", timeoutMs: "60000"
};
app.components.settings.openAddModel();
await lastForm.querySelector("[data-save]").onclick();

assert.equal(app.config.connection.endpoint, VIBE_ENDPOINT, "保存后 connection 必须记住地址");
assert.equal(app.config.connection.apiKey, VIBE_PASSWORD, "保存后 connection 必须记住密码");

const added = app.config.models.filter((item) => item.name === "家里的 CVP")[0];
assert.ok(added, "新卡应该在模型表里");
assert.equal(added.endpoint, VIBE_ENDPOINT, "新卡自己的地址也该是刚填的那个");

const storedConfig = mem.get("config/app");
assert.equal(storedConfig.connection.endpoint, VIBE_ENDPOINT, "落盘的那份配置同样要有地址");
assert.ok(storedConfig.models.every((item) => item.protocol !== "cvp" || item.endpoint === VIBE_ENDPOINT),
  "所有 cvp 卡都应该分发到同一个地址");

/* 2) 编辑一张已有的 CVP 卡改地址,保存后一样要生效。
      这是用户实际走的那条路(模型设置 → 编辑)。 */
const target = app.config.models[0];
assert.equal(target.protocol, "cvp", "第一张出厂卡是 CVP");
fieldValues = {
  name: target.name, protocol: "cvp",
  endpoint: "http://192.168.124.31:8189/vibedraw/", apiKey: "changed-password", customHeaders: "",
  size: "512", refStrength: "100", steps: "8", timeoutMs: "60000"
};
editIds = [target.id];
app.components.settings.openModels();
const editButton = lastForm.querySelectorAll("[data-edit]")[0];
assert.ok(editButton && editButton.onclick, "模型卡上应该有编辑入口");
editButton.onclick();

await lastForm.querySelector("[data-save]").onclick();
assert.equal(app.config.connection.endpoint, "http://192.168.124.31:8189/vibedraw/", "编辑后 connection 要更新");
assert.equal(app.config.connection.apiKey, "changed-password", "编辑后密码要更新");
assert.ok(app.config.models.every((item) => item.protocol !== "cvp" || item.apiKey === "changed-password"),
  "改一次密码,所有 cvp 卡一起改");

/* 3) 换到非 CVP 协议保存,不能把已经填好的 CVP 连接冲掉(它是别的协议不关心的那份) */
fieldValues = {
  name: "远端接口", protocol: "cvp",
  endpoint: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-image-1", customHeaders: "",
  size: "1024", refStrength: "100", steps: "8", timeoutMs: "60000"
};
app.components.settings.openAddModel();
const selector = lastForm.querySelector('[name="protocol"]');
selector.value = "openai-images";
selector.onchange();
await lastForm.querySelector("[data-save]").onclick();

assert.equal(app.config.connection.endpoint, "http://192.168.124.31:8189/vibedraw/", "非 CVP 卡不该动 CVP 连接");
assert.equal(app.config.connection.apiKey, "changed-password", "非 CVP 卡不该动 CVP 密码");
const remote = app.config.models.filter((item) => item.name === "远端接口")[0];
assert.ok(remote && remote.protocol === "openai-images", "换协议后应该存成非 CVP 卡");
assert.equal(remote.endpoint, "https://api.openai.com/v1", "非 CVP 卡的地址走它自己那份");
assert.equal(remote.apiKey, "sk-test", "非 CVP 卡的密钥走它自己那份");

/* 4~5) 选到 CVP 时"服务器地址"的预填规则(2026-09-26 用户要求):
         还没有记录过地址 → 预填一条样例;已经记录过 → 原样显示,绝不覆盖。 */
const endpointValueIn = (html) => {
  const match = /name="endpoint"[^>]*\bvalue="([^"]*)"/.exec(html || "");
  return match ? match[1] : null;
};

app.config.connection = { endpoint: "", apiKey: "", customHeaders: "" };
fieldValues = {
  name: "新机器", protocol: "cvp", endpoint: "", apiKey: "", customHeaders: "",
  size: "512", refStrength: "100", steps: "8", timeoutMs: "60000"
};
app.components.settings.openAddModel();
assert.equal(endpointValueIn(lastBody), app.defaults.cvpEndpoint, "还没填过地址时,表单要预填样例地址");
assert.ok(String(app.defaults.cvpEndpoint).indexOf(":8189/vibedraw") > 0,
  "样例地址必须带 /vibedraw —— 同一台机器的 8188 是另一个服务,照着填必错");

/* 用户没改这一格,直接保存 —— 表单里读到的就是预填的那条 */
lastForm.nodes.endpoint.value = app.defaults.cvpEndpoint;
await lastForm.querySelector("[data-save]").onclick();
assert.equal(app.config.connection.endpoint, app.defaults.cvpEndpoint, "预填的地址要随保存落进 connection");

const CUSTOM_ENDPOINT = "http://10.0.0.8:8189/vibedraw";
app.config.connection = { endpoint: CUSTOM_ENDPOINT, apiKey: "keep-me", customHeaders: "" };
fieldValues = {
  name: "已填过的机器", protocol: "cvp", endpoint: CUSTOM_ENDPOINT, apiKey: "keep-me", customHeaders: "",
  size: "512", refStrength: "100", steps: "8", timeoutMs: "60000"
};
app.components.settings.openAddModel();
assert.equal(endpointValueIn(lastBody), CUSTOM_ENDPOINT, "已经记录过地址时,表单不能拿样例覆盖它");
assert.equal(app.config.connection.endpoint, CUSTOM_ENDPOINT, "只是打开表单,不该动配置里的地址");

console.log("settings.test.mjs: ok");
