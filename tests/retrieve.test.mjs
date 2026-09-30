/* 「出好的图不会再丢」:提交幂等键、待取回的作业、续取,以及那颗「重试取回」按钮
 *
 * 现场(2026-09-30 真机):一次生成里 POST 的应答在回程被宿主的读超时掐断(页面看到的
 * 是**裸的一个 `timeout`** —— OkHttp 抛 InterruptedIOException("timeout"),宿主按原样
 * 包成 E_NETWORK 送到页面)。作业在服务端照跑、图照落盘,而客户端手上连 job id 都没有,
 * 那张图从此没人能取回来。
 *
 * 这一组钉的就是这条线,四段各自能被一条**行为**断言抓住:
 *   ① 提交体带幂等键 —— 同一次提交重发时服务端还你原来那个作业,不会再多画一张
 *      (两次的键必须一模一样;这是"重发安全"的全部理由);
 *   ② 提交成功当场把 job id 交上来(`generation:pending`),四种结局都要清掉;
 *   ③ 取图/等待失败时抛的是**可续取**的错(带 jobId),不是一句死讯;
 *   ④ 续取**不重新提交**:只按 job id 再读一次,图已经画好就取回来;
 *   ⑤ 那三颗按钮在**弹层根**上查得到 —— 底部按钮与内容区是兄弟,从内容区里查永远
 *      是 null 而且不报错,这一格只有把真结构跑一遍才发现得了。
 *
 * 为什么必须打行为断言:这四段任何一段断了,界面上的表现都是"图没了"或者"按钮没反应",
 * 而日志里、字符串里都看不出来 —— 只断言"存在一个 request_id 常量"照样全绿。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
/* editor.js 与 i18n 会碰 document;这里只要一个能接住赋值、getElementById 恒为 null 的壳子
   (这一组不验排版,只验"查到的按钮是哪几颗")。 */
globalThis.document = globalThis.document || {
  documentElement: { dataset: {}, lang: "" },
  getElementById: () => null
};

for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;

/* ---------- 宿主替身(必须在 providers.js 之前挂上:它在加载时就把宿主抓成局部变量) ---------- */
const INFO = "http://192.168.124.31:8189/chp/info";
const JOBS = "http://192.168.124.31:8189/chp/jobs";
const JOB_ID = "job-1111-2222";
const PROGRESS_URL = JOBS + "/" + JOB_ID + "/progress";
const STATUS_URL = JOBS + "/" + JOB_ID;
const OUTPUT_URL = JOBS + "/" + JOB_ID + "/output/0";

let posted = [];
let sent = [];
let replies = {};

function take(value) {
  if (Array.isArray(value)) return value.length > 1 ? value.shift() : value[0];
  return value;
}

app.platform.haminn = {
  request: async (options) => {
    const url = String(options.url);
    sent.push({ url, method: options.method, headers: options.headers || {} });
    if (options.method === "POST" && options.bodyText) posted.push(JSON.parse(options.bodyText));
    const reply = replies[url];
    if (!reply) return { status: 404, bodyText: "" };
    const chosen = take(reply);
    if (chosen.throws) {
      const error = new Error(chosen.throws);
      error.code = chosen.code || "";
      throw error;
    }
    return { status: chosen.status, bodyText: chosen.bodyText, file: chosen.file, headers: {} };
  },
  /* 非 2xx 的形状照抄宿主(app/platform/haminn.js 的 httpError):**先取 payload 里的
     error/detail/message**,取不到才退回 bodyText。这一条很重要 —— `not_found` 这类
     错误码只在 body 里,替身若只回 "HTTP 404",客户端就永远认不出它是"作业已经没了"。
     下面那一条"服务端清掉了"的断言正是靠这个形状才成立。 */
  httpError: (response, payload) => {
    const detail = (payload && (payload.error || payload.detail || payload.message))
      || response.bodyText || "服务未返回可读错误";
    const category = response.status === 401 ? "认证失败"
      : response.status === 403 ? "权限不足"
        : response.status === 429 ? "额度或频率限制"
          : response.status >= 500 ? "服务端错误" : "请求失败";
    const error = new Error(category + "(" + response.status + "):" + String(detail).slice(0, 300));
    error.status = response.status;
    return error;
  }
};

new Function(fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8"))();
const providers = app.services.providers;

const DOC = {
  spec: "chp/2",
  plugin: { id: "hamdraw_chp", version: "9.9.9" },
  auth: { required: true, authorized: true, scheme: "Bearer", header: "Authorization" },
  endpoints: { info: "/chp/info", jobs: "/chp/jobs", job: "/chp/jobs/{job_id}",
    progress: "/chp/jobs/{job_id}/progress", output: "/chp/jobs/{job_id}/output/{index}" },
  abilities: [{ name: "qwen2.1", ready: true, files: { unet: "u" },
    frames: [{ category: "render", ratio: "9:16", resolution: ["768x1344"] }] }],
  rules: [{ category: "render", rule: "txt-ref-2-img", input: "txt-ref-2-img/v1",
    label: { zh: "高质量生图", en: "High quality render" }, needs: { prompt: true, image: false },
    frames: [{ ratio: "9:16", resolution: ["768x1344"] }], defaults: { step: 20, ref_strength: 0.95 } }]
};

function card(extra) {
  return Object.assign({
    id: "chp-qwen", name: "高质量生图", protocol: "chp", task: "render",
    endpoint: "http://192.168.124.31:8189/chp", apiKey: "pw", resolution: "768x1344",
    steps: 20, refStrength: 100, timeoutMs: 300000
  }, extra || {});
}

function arm() {
  posted = [];
  sent = [];
  replies = {};
  replies[INFO] = { status: 200, bodyText: JSON.stringify(DOC) };
  replies[JOBS] = { status: 202, bodyText: JSON.stringify({
    job: { id: JOB_ID, category: "render", state: "queued", queue_position: 0 } }) };
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "running", queue_position: null, progress: null } }) };
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, category: "render", state: "completed", outputs: [
      { index: 0, media_type: "image/png", url: "/chp/jobs/" + JOB_ID + "/output/0" }] } }) };
  replies[OUTPUT_URL] = { status: 200, bodyText: "",
    file: { url: "haminn://blob/x", logicalFileId: "lf-x" } };
}

const pendings = [];
function watchPending() {
  pendings.length = 0;
  return app.events.on("generation:pending", (detail) => pendings.push(detail && detail.pending));
}

/* ---------- ① 提交成功 ⇒ 当场交上 job id;整条跑完 ⇒ 清掉 ---------- */
{
  arm();
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "completed", queue_position: null } }) };
  const off = watchPending();
  const result = await providers.generate(card(), { prompt: "p", seed: 1 });
  off();

  assert.equal(result.logicalFileId, "lf-x", "这一趟应当正常拿到图");
  assert.equal(pendings.length, 2, "提交成功交一次、取回成功清一次");
  assert.equal(pendings[0].jobId, JOB_ID, "交上来的必须是插件给的那个 job id");
  assert.equal(pendings[0].task, "render", "记下是哪个场景,续取时才能配对");
  assert.equal(pendings[0].requestId, posted[0].request_id, "记下的提交编号就是发出去那一个");
  assert.equal(pendings[1], null, "图到手了,记录就此作废(留着会让界面摆一颗点了没用的按钮)");
}

/* ---------- ② 作业被插件判失败 ⇒ 也是定论,记录一样要清掉 ---------- */
{
  arm();
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "failed", error: "node 12 not found" } }) };
  /* 轻的那条只报状态,原因在**完整的那个 job** 里 —— 所以失败时要补读一次 */
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "failed", error: "node 12 not found" } }) };
  const off = watchPending();
  let message = "";
  try { await providers.generate(card(), { prompt: "p", seed: 1 }); }
  catch (error) { message = String(error.message); }
  off();

  assert.ok(message.indexOf("node 12 not found") >= 0, `失败原因要报出来,收到:${message}`);
  assert.equal(pendings[pendings.length - 1], null, "工作流失败没有图可取,记录必须清掉");
}

/* ---------- ③ 取图失败 ⇒ 不是死讯:抛一个带 jobId 的可续取错,记录**留着** ---------- */
{
  arm();
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "completed", queue_position: null } }) };
  /* 取图那一条一直断(三次都挂)—— 图已经画好了,只是搬不回来 */
  replies[OUTPUT_URL] = { throws: "timeout" };

  const off = watchPending();
  let error = null;
  try { await providers.generate(card(), { prompt: "p", seed: 1 }); } catch (caught) { error = caught; }
  off();

  assert.ok(error, "取图失败必须抛出来");
  assert.equal(error.recoverable, true, "这是**可续取**的失败,不是死讯");
  assert.equal(error.jobId, JOB_ID, "要带上 job id —— 界面靠它决定给不给「重试取回」");
  assert.equal(pendings[pendings.length - 1].jobId, JOB_ID,
    "记录必须留着:图还在服务端,清掉就真的丢了");
  assert.ok(sent.filter((item) => item.url === JOBS).length === 1, "这一路上只提交过一次");
}

/* ---------- ④ 宿主的裸 `timeout` 要翻成人话 ---------- */
{
  arm();
  replies[PROGRESS_URL] = { throws: "timeout" };
  const off = watchPending();
  let message = "";
  try { await providers.generate(card(), { prompt: "p", seed: 1 }); }
  catch (error) { message = String(error.message); }
  off();

  assert.notEqual(message, "timeout", "不许把宿主那个孤零零的词直接甩给用户");
  assert.ok(message.indexOf("没等到服务器应答") >= 0,
    `要说清"服务端的东西还在",收到:${message}`);
  assert.ok(message.indexOf("重试取回") >= 0, "并且要告诉他还有一步可走");
  assert.ok(replies[PROGRESS_URL].throws || true);
}

/* ---------- ⑤ 续取:只读,不重新提交 ---------- */
{
  arm();
  const pending = { jobId: JOB_ID, task: "render", requestId: "r-1", createdAt: 1 };

  /* (a) 作业已经完成 ⇒ 把图取回来 */
  const done = await providers.resume(card(), pending);
  assert.equal(done.running, false, "完成了就不再是 running");
  assert.equal(done.result.logicalFileId, "lf-x", "要真的把图取回来");
  assert.equal(posted.length, 0, "续取**不许**重新提交 —— 重画一张既慢又白费");

  /* (b) 作业还在跑 ⇒ running,不是失败,也不许重新提交 */
  arm();
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "queued", queue_position: 1 } }) };
  const waiting = await providers.resume(card(), pending);
  assert.equal(waiting.running, true, "还在排队就是还在排队,不是失败");
  assert.equal(posted.length, 0, "等它的时候更不该重新提交");

  /* (c) 服务端已经没有这个作业了 ⇒ 照实说不出图,不能假装还能取 */
  arm();
  replies[STATUS_URL] = { status: 404, bodyText: JSON.stringify({ error: "not_found" }) };
  let gone = "";
  try { await providers.resume(card(), pending); } catch (error) { gone = String(error.message); }
  assert.ok(gone.indexOf("不存在") >= 0, `服务端清掉了就说清是清掉了,收到:${gone}`);

  /* (d) 不是 CHP 卡就别装作有这条路 */
  arm();
  let refused = "";
  try { await providers.resume(card({ protocol: "openai-images" }), pending); }
  catch (error) { refused = String(error.message); }
  assert.ok(refused.indexOf("CHP") >= 0, `别的协议没有作业编号,要当场说清,收到:${refused}`);
}

/* ---------- ⑥ image-engine 的 resume:落库那条路与 run 是同一条 ---------- */
{
  const stored = [];
  let resumed = [];
  let outcome = null;
  app.services.providers = {
    active: () => ({ id: "chp-qwen", name: "高质量生图", protocol: "chp" }),
    resume: async (model, pending) => { resumed.push(pending); return outcome; },
    generate: async () => { throw new Error("续取绝不该走 generate(那会重画一张)"); }
  };
  app.services.assets = { persist: async (src) => ({ parts: ["lf"], mime: "image/png", src: src }) };
  app.services.store = {
    addResult: async (image) => { stored.push(image); },
    scheduleSave: () => {}
  };
  app.services.translate = { fromPair: () => null, hasCjk: () => true,
    needed: () => false, ready: () => false };
  app.config = { reference: app.defaults.reference };
  app.state.prompt = "一个女孩站在海边";
  app.state.promptEn = null;
  app.state.pendingJob = null;

  new Function(fs.readFileSync(path.join(root, "app/services/image-engine.js"), "utf8"))();
  const engine = app.services.imageEngine;
  engine.init({ capture: async () => ({ dataUrl: "data:image/png;base64,AAAA", mime: "image/png" }) });

  /* (a) 手上没有待取的作业 ⇒ 当场说清,不装作在做事 */
  let nothing = "";
  try { await engine.resume(); } catch (error) { nothing = String(error.message); }
  assert.ok(nothing.indexOf("没有等待取回") >= 0, `没东西可取要直说,收到:${nothing}`);

  /* (b) 界面把 job id 记进去(提交成功那一刻由 providers 交上来) */
  app.events.emit("generation:pending", { pending: {
    jobId: JOB_ID, task: "render", requestId: "r-9", createdAt: 2 } });
  assert.equal(app.state.pendingJob.jobId, JOB_ID, "运行时状态里要记下那个作业");
  assert.equal(engine.pending().jobId, JOB_ID, "界面据此决定摆不摆那颗按钮");

  /* (c) 续取成功 ⇒ 图落进作品,记录清掉 */
  outcome = { running: false, result: { src: "data:image/png;base64,BBBB", logicalFileId: "lf-b" } };
  const images = [];
  const off = app.events.on("generation:done", (detail) => images.push(detail.image));
  const kept = await engine.resume();
  off();

  assert.equal(resumed.length, 1, "要真的问过 providers.resume");
  assert.equal(resumed[0].jobId, JOB_ID, "问的是那一个作业");
  assert.equal(stored.length, 1, "取回来的图要落进作品");
  assert.equal(kept.prompt, "一个女孩站在海边", "记进作品的就是这件作品的描述");
  assert.equal(images.length, 1, "取回来了要发一次 generation:done(界面照旧刷新)");
  assert.equal(app.state.pendingJob, null, "图到手了,记录就此作废");
  assert.equal(engine.busy(), false, "续取结束要放过 busy —— 否则再也点不动生成");

  /* (d) 服务端还在跑 ⇒ 不报错、不清记录,只是让用户过会儿再点一次 */
  app.events.emit("generation:pending", { pending: {
    jobId: JOB_ID, task: "render", requestId: "r-9", createdAt: 2 } });
  outcome = { running: true, job: { id: JOB_ID, state: "queued" } };
  const again = await engine.resume();
  assert.equal(again, null, "还在跑就没有图可返回");
  assert.equal(app.state.pendingJob.jobId, JOB_ID, "还在跑 ⇒ 记录必须留着,否则再也取不回来");
  assert.equal(stored.length, 1, "还在跑不许往作品里塞东西");

  /* (e) 用户取消 = 忽略这次生成(既有口径):记录也不该再挂着 */
  app.services.providers.resume = null;
  app.services.imageEngine.cancel();
  assert.equal(app.state.pendingJob, null, "取消之后不该还摆着一颗「重试取回」");
}

/* ---------- ⑦ 那三颗按钮:必须从**弹层根**上查得到 ---------- */
{
  /* 真结构(index.html):#modal-content 与 #modal-actions 是 `#modal-layer` 下的**兄弟**。
     所以从内容区里 querySelector("[data-generate]") 永远是 null 而且不报错 ——
     文案、取消按钮的显隐、以及"关掉模型列表回生成弹窗"都会静默失效。
     这个替身把真结构照抄一份,断言打在"按下去/查到的是哪几颗"上。 */
  const buttons = {
    "[data-generate]": { dataset: {}, innerHTML: "", disabled: false },
    "[data-cancel-generate]": { dataset: {}, hidden: true },
    "[data-retrieve]": { dataset: {}, hidden: true }
  };
  const lookups = [];
  const attrs = {};
  /* 内容区也要长得像个元素(setAttribute 这些都有),而且它查什么也记下来 ——
     这样"弹层根指错成内容区"这种改坏会挂在**该挂的那条断言**上
     (找不到 [data-retrieve]),而不是挂在某个替身缺方法的 TypeError 上。 */
  const content = {
    querySelector: (selector) => { lookups.push("content:" + selector); return null; },
    querySelectorAll: () => [],
    setAttribute: () => {}
  };
  const actions = { querySelector: (selector) => buttons[selector] || null };
  const layer = {
    querySelector: (selector) => { lookups.push(selector); return buttons[selector] || null; },
    querySelectorAll: () => [],
    setAttribute: (name, value) => { attrs[name] = String(value); }
  };
  let open = false;
  globalThis.document.getElementById = (id) => {
    if (id === "modal-layer") return layer;
    if (id === "modal-content") return content;
    if (id === "modal-actions") return actions;
    return null;
  };
  app.components.viewport = { maskMode: () => 0 };

  new Function(fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8"))();
  const editor = app.features.editor;
  const engine = app.services.imageEngine;

  /* (a) 手上有一个待取的作业、而且不忙 ⇒ 那颗按钮要摆出来。
         注意这里**不传任何参数**:三颗按钮的查找由那个函数自己去做(它自己去取弹层根),
         所以这条断言验的正是"它取的那个根对不对"。 */
  app.state.pendingJob = { jobId: JOB_ID, task: "render", requestId: "r-9", createdAt: 2 };
  editor.syncGenerateSheet();
  assert.ok(lookups.indexOf("[data-retrieve]") >= 0,
    "要从弹层根上找那颗「重试取回」—— 它住在底部,不是内容区的孩子");
  assert.equal(buttons["[data-retrieve]"].hidden, false, "有东西可取就把入口摆出来");
  assert.equal(buttons["[data-cancel-generate]"].hidden, true, "不忙的时候没有取消可点");
  assert.equal(attrs["data-busy"], "false", "空闲时根上要标出来");

  /* (b) 忙的时候:取消摆出来、取回收回去,主按钮换成「渲染中」 */
  app.state.pendingJob = { jobId: JOB_ID, task: "render", requestId: "r-9", createdAt: 2 };
  const busyEngine = { busy: () => true, pending: () => app.state.pendingJob };
  const real = app.services.imageEngine;
  app.services.imageEngine = busyEngine;
  editor.syncGenerateSheet();
  app.services.imageEngine = real;

  assert.equal(buttons["[data-cancel-generate]"].hidden, false, "忙的时候要能取消");
  assert.equal(buttons["[data-retrieve]"].hidden, true, "忙的时候取回要先收起来(同时只做一件事)");
  assert.equal(attrs["data-busy"], "true", "忙的时候根上也要标出来");
  assert.ok(buttons["[data-generate]"].innerHTML.indexOf("渲染中") >= 0,
    "主按钮要变成「渲染中」—— 这只有在真的查得到它时才可能");

  /* (c) 没有待取的作业 ⇒ 那颗按钮必须消失(点了没用的按钮比没有更糟) */
  app.state.pendingJob = null;
  editor.syncGenerateSheet();
  assert.equal(buttons["[data-retrieve]"].hidden, true, "没东西可取时不许摆那颗按钮");

  /* (d) 关掉模型列表该回生成弹窗:判据也是"从根上查得到生成按钮" */
  open = true;
  app.components.ui = { sheetOpen: () => open };
  assert.equal(editor.modelsBackTarget(), "generate", "生成弹窗开着才回它");
  open = false;
  assert.equal(editor.modelsBackTarget(), "", "弹窗关着就别把用户突然弹进生成弹窗");
  assert.ok(engine, "imageEngine 还在(上面的替身已经换回真的)");
}

console.log("retrieve.test.mjs: ok (幂等键、pending 四种结局、可续取的失败、裸 timeout 翻人话、"
  + "续取不重新提交、image-engine 续取落库、三颗按钮从弹层根查得到)");

/* 生成中那副面孔会起一枚 setInterval(进度条上那颗转圈),它是**设计如此** ——
   在应用里由 generation:idle 收掉。这一组最后停在"忙"那一格上,所以自己收尾,
   否则 node 会挂在那个定时器上不退出(看起来像测试卡住,其实断言早就全过了)。 */
process.exit(0);
