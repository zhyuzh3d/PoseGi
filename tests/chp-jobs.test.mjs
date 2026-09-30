/* CHP 的任务提交与轮询(`POST /chp/jobs` → `GET …/progress` → `GET …` → 输出)
 *
 * 这组锁的是**这一轮迁移本身**:插件从 `chp/1` 升到 `chp/2`(插件 3.0.0)之后,
 * 客户端发出去的东西改了七处,每一处错了都**不报错**、只是没图或空等:
 *
 *   1. 场景名从"能力名 + 别名换算"改成**直接发 `category`**(`fast` / `inpaint` /
 *      `upscale` / `render`)。`chp/2` 没有别名,`quick` / `qwen` 发过去就是
 *      `unsupported_category`;
 *   2. 画幅从 `size: [w, h]` 改成 **`resolution: "WxH"` 字符串**,而且只能逐项命中
 *      插件公布的帧表 —— 表外一律 `400 unsupported_size`,客户端不再"在数值域内算一张";
 *   3. 步数与负向提示词搬进 **`ext_params`**(模型层通道,规范不定义任何字段,原样携带
 *      原样回显)。顶层发 `steps` / `negative_prompt` 会被**静默忽略**并列进 `job.ignored`;
 *   4. 密码搬进 **`chp_params.password`**,而且**带 body 的请求不再带 Authorization** ——
 *      一个请求只用一种密码载体(GET 带不了 body,只能走头,不带就永远 401);
 *   5. 地址一律从文档的 **`endpoints`** 里读(客户端不许自己拼);
 *   6. 协议大版本对不上要**当场停下**,不能拿旧规则继续猜;
 *   7. 参考图基准取自 **`rules[].defaults.ref_strength`**(插件改默认,本应用不用跟着发版)。
 *
 * ---------- 2026-09-30 追加:宽高比锁死 9:16 ----------
 *
 * 本应用一律出竖幅(见 app.defaults.ratio),所以真正会发出去的画幅只有帧表里
 * **标着 `9:16`** 的那一档。真夹具里只有 `render` 公布了它(768x1344)——`fast` 与
 * `upscale` 只有 1:1 / 4:3 / 3:4,在锁竖幅之后**出不了图**。那正是这些用例的主角:
 * 挑不出 9:16 档要当场说清"这个场景还没有竖幅",**不许**退回出厂值去撞一个 400。
 *
 * 夹具 `tests/fixtures/chp-info-3.0.2.json` 是**从 A1X 真机的 `GET /chp/info` 原样抓下来
 * 的那一份**(2026-09-29,插件 3.0.0;唯一的改动是把 `auth.authorized` 置 true,因为
 * 抓取时没带密码)。用真文档而不是手写一份,是因为"手写的那份比真文档多一个字段"
 * 正是这次断链的成因 —— `abilities[].id` 在真文档里根本不存在。
 *
 * 加载顺序:providers.js 在加载时就把宿主抓成局部变量,所以替身要先挂上再加载它。
 * 另外 `chpDocument` 是**模块级状态**,"读过文档才按帧表发"这件事必须先调一次
 * `providers.test(...)`(也就是设置面板里的「测试连接」)才成立 —— 用例里的 prime()。
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

/* ---------- 宿主替身 ---------- */
let asked = [];              // 每条请求的 url
let posted = [];             // 提交体(解析后的对象)
let sent = [];               // 每条请求的 { url, method, headers, timeoutMs }
let replies = {};            // url → 回答;值可以是数组(按次序依次消费,最后一次重复使用)

function take(value) {
  if (Array.isArray(value)) return value.length > 1 ? value.shift() : value[0];
  return value;
}

app.platform.haminn = {
  request: async (options) => {
    const url = String(options.url);
    asked.push(url);
    sent.push({ url, method: options.method, headers: options.headers || {}, timeoutMs: options.timeoutMs });
    if (options.method === "POST" && options.bodyText) posted.push(JSON.parse(options.bodyText));
    const reply = replies[url];
    if (!reply) return { status: 404, bodyText: "" };
    const chosen = take(reply);
    /* 宿主会**抛**,而不是回一个非 2xx:真机实测那次是读响应体超时裸抛出来的
       `java.net.SocketTimeoutException`,被桥兜底成 E_INTERNAL +「内部错误」。
       替身必须能演这一路,否则这些用例永远碰不到真实故障的形状。 */
    if (chosen.throws) {
      const error = new Error(chosen.throws);
      error.code = chosen.code || "";
      throw error;
    }
    return { status: chosen.status, bodyText: chosen.bodyText, file: chosen.file, headers: {} };
  },
  httpError: (response) => new Error("HTTP " + response.status)
};

new Function(fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8"))();
const providers = app.services.providers;
const internals = providers.internals;

/* ---------- 夹具:真机文档 ---------- */
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/chp-info-3.0.2.json"), "utf8"));

assert.equal(FIXTURE.spec, "chp/2", "夹具本身必须是 chp/2");
assert.deepEqual(FIXTURE.rules.map((item) => item.category).sort(),
  ["fast", "inpaint", "render", "upscale"], "四个场景词就是这四个,没有别名");
assert.ok(!("capabilities" in FIXTURE), "夹具里不该再有 chp/1 的 capabilities");
assert.ok(!("models" in FIXTURE), "夹具里不该再有 chp/1 的 models");
assert.ok(FIXTURE.abilities.every((item) => !("id" in item)),
  "真文档的 abilities 条目**没有 id** —— 客户端不许靠它认能力");
assert.ok(FIXTURE.abilities.every((item) => Array.isArray(item.frames) && item.frames.length),
  "就绪与帧表都挂在 abilities 上");
/* 这台插件上只有 render 公布了 9:16 —— 整组用例的前提,写成断言免得上游偷偷改了。
   2026-09-30 那次加档把 9:16 从一档变成三档(768×1344 / 576×1024 / 432×768),
   **顺序有意义**:默认发的是第 0 条,所以下面那条"发出去的是 768x1344"仍然成立。 */
assert.deepEqual(
  FIXTURE.abilities.flatMap((item) => item.frames)
    .filter((frame) => frame.ratio === "9:16")
    .map((frame) => [frame.category, ...frame.resolution]),
  [["render", "768x1344", "576x1024", "432x768"]],
  "真夹具里只有 render 有 9:16 档,而且是这三档、这个顺序");

/* 复制一份夹具再改,免得用例之间互相污染 */
function doc(mutate) {
  const copy = JSON.parse(JSON.stringify(FIXTURE));
  if (mutate) mutate(copy);
  return copy;
}
/* 换掉某个场景的帧:按 category 找到管它的那条 ability,只替换那几条帧条目 */
function withFrames(category, frames) {
  return (copy) => {
    copy.abilities.forEach((ability) => {
      const others = ability.frames.filter((frame) => frame.category !== category);
      if (others.length === ability.frames.length) return;   // 这条能力不管这个场景
      ability.frames = others.concat(JSON.parse(JSON.stringify(frames)));
    });
  };
}
/* 只保留某个场景标着 9:16 的那些帧,其余同场景的帧全部丢掉 */
function onlyFrames(category, frames) {
  return withFrames(category, frames);
}

const HOST = "http://192.168.1.31:8189";
const BASE = HOST + "/chp";
const JOBS = BASE + "/jobs";
const JOB_ID = "0d5b6a7c-1111-4222-8333-444455556666";
const INFO_URL = BASE + "/info";
const PROGRESS_URL = JOBS + "/" + JOB_ID + "/progress";
const STATUS_URL = JOBS + "/" + JOB_ID;
const OUTPUT_URL = JOBS + "/" + JOB_ID + "/output/0";

function card(task) {
  const value = providers.preset("chp", task);
  value.endpoint = BASE;
  value.apiKey = "test-chp-password";
  return value;
}

/* 一遍完整的提交:读文档 → 提交 → 轮询若干次 → 取图 */
function arm(options) {
  const settings = options || {};
  asked = [];
  posted = [];
  sent = [];
  replies = {};
  replies[INFO_URL] = { status: 200, bodyText: JSON.stringify(settings.document || doc()) };
  replies[JOBS] = { status: 202, bodyText: JSON.stringify({
    job: { id: JOB_ID, category: settings.category || "render", state: "queued", queue_position: 0 } }) };
  /* 默认第一次轮询就报终态 —— 每条用例各自覆盖成自己需要的序列。
     轮询只有在**终态**才跳出,给一个永远 running 的回答会让这条用例死等到超时。 */
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, state: "completed", queue_position: null, progress: null } }) };
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({
    job: { id: JOB_ID, category: settings.category || "render", state: "completed", queue_position: null, progress: null,
      outputs: [{ index: 0, filename: "render_00001_.png", subfolder: "hamdraw", type: "output",
        media_type: "image/png", url: OUTPUT_URL }] } }) };
  replies[OUTPUT_URL] = { status: 200, bodyText: "", file: { url: "haminn://blob/chp-1", logicalFileId: "lf-chp-1" } };
}

/* 把文档读进来 —— 帧表、规则、地址三件事都以此为准,不读就只有出厂值可用 */
async function prime(task) { await providers.test(card(task || "render")); }

/* 1) 提交体:字段名、形状、密码载体、地址、返回值。
      最强的一条是"每个顶层键都在文档公布的 schema 里":插件对不认识的键不报错、
      只忽略并列进 `job.ignored` —— 那正是"改了名没跟着改"能静默通过的地方。
      用 render 而不是 fast,因为锁 9:16 之后**只有这个场景在这台插件上出得了图**。 */
{
  arm();
  await prime();

  const progressLog = [];
  const off = app.events.on("generation:progress", (detail) => progressLog.push(detail.stage));

  const result = await providers.generate(card("render"),
    { prompt: "一个科幻女战士", negativePrompt: "low quality", seed: 7,
      imageDataUrl: "data:image/png;base64,AAAA" });

  assert.equal(posted.length, 1, "应该只提交一次");
  const body = posted[0];
  assert.equal(body.category, "render", "场景名就是卡上那一栏,直接发 category");
  assert.equal(body.capability, undefined, "chp/2 没有能力名这个东西");
  assert.equal(body.task, undefined, "task 是 chp/1 的旧拼写,发了会被忽略");
  assert.equal(body.resolution, "768x1344", "画幅取自帧表里标着 9:16 的那一档");
  assert.match(body.resolution, /^\d+x\d+$/, "文档对 resolution 的 pattern 就是这一条");
  assert.equal(body.size, undefined, "chp/2 的 size 是数组形式,已删");
  assert.equal(body.seed, 7, "种子要原样带上");
  assert.equal(typeof body.ref_strength, "number");
  assert.deepEqual(body.ext_params, { step: 20, negative_prompt: "low quality" },
    "步数与负向提示词都走模型层通道;render 的出厂步数是 20");
  assert.equal(body.steps, undefined, "顶层 steps 会被放进 job.ignored");
  assert.equal(body.negative_prompt, undefined, "顶层 negative_prompt 会被放进 job.ignored");
  assert.deepEqual(body.chp_params, { password: "test-chp-password" }, "密码走 CHP 层通道");
  assert.equal(typeof body.image_base64, "string", "参考图按数据 URL 原样带");

  const schema = FIXTURE.input_schemas["txt-ref-2-img/v1"];
  const declared = Object.keys(schema.properties);
  Object.keys(body).forEach((key) => {
    assert.ok(declared.indexOf(key) >= 0, `顶层字段 ${key} 不在文档公布的 schema 里,会被静默忽略`);
  });
  schema.required.forEach((key) => assert.ok(key in body, `文档要求必填的 ${key} 没发`));

  const submit = sent.filter((item) => item.url === JOBS)[0];
  assert.ok(submit, "要打 /chp/jobs");
  assert.equal(submit.headers.Authorization, undefined,
    "带 body 的请求不许再带 Authorization(一个请求只用一种密码载体)");
  assert.equal(submit.headers["Content-Type"], "application/json");

  ["progress", "job", "output"].forEach((part) => {
    const calls = sent.filter((item) => item.url.indexOf(JOB_ID) >= 0 && item.url.indexOf(part) >= 0);
    assert.ok(calls.length, `要问过 ${part}`);
    calls.forEach((call) => {
      assert.equal(call.headers.Authorization, "Bearer test-chp-password", `${part} 这条 GET 必须带 Bearer`);
    });
  });

  assert.ok(asked.indexOf(JOBS) >= 0, "提交要打文档给的 jobs 地址");
  assert.ok(asked.indexOf(PROGRESS_URL) >= 0, "等待期间要问轻的 /progress");
  assert.ok(asked.indexOf(STATUS_URL) >= 0, "拿到终态后要读一次完整状态");

  assert.equal(result.src, "haminn://blob/chp-1");
  assert.equal(result.logicalFileId, "lf-chp-1", "宿主给的逻辑文件 id 要透传(媒体字节靠它进备份)");
  assert.equal(result.metadata.state, "completed");
  assert.ok(progressLog.indexOf("download") >= 0, "要报出取图这一步");
  off();
}

/* 1b) 锁 9:16 之后,**帧表里没有 9:16 的场景出不了图** —— 而且要说清是哪一种缺、
      该去哪儿加。真机上 fast / upscale 就是这种情况(只有 1:1 与 4:3、3:4)。
      这条同时守住一个反面:不许退回出厂值硬发(那会换来一个看不懂的 400)。 */
{
  arm();
  await prime();
  let message = "";
  try { await providers.generate(card("fast"), { prompt: "p", seed: 1 }); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("快速生图") >= 0, `要点名是哪个场景缺,收到:${message}`);
  assert.ok(message.indexOf("9:16") >= 0, `要说清缺的是哪个比例,收到:${message}`);
  assert.ok(message.indexOf("加一档") >= 0 || message.indexOf("插件") >= 0,
    `要告诉用户去哪儿加,收到:${message}`);
  assert.equal(posted.length, 0, "挑不出画幅时**一个字节都不该发出去**");

  /* 反过来说:同一张卡,只要插件补了一档 9:16,它就立刻能用 ——
     这条证明上面那句拦的不是"fast 这个场景",而是"这台插件上 fast 没有竖幅"。 */
  arm({ document: doc(onlyFrames("fast", [{ ratio: "9:16", resolution: ["576x1024"], category: "fast" }])) });
  await prime();
  await providers.generate(card("fast"), { prompt: "p", seed: 1 });
  assert.equal(posted[0].resolution, "576x1024", "插件补了竖幅就该照发");
}

/* 2) 地址真的从 `endpoints` 里读:把文档里的前缀改掉,请求要跟着换。
      只断言"等于 /chp/xxx"的话,把 chpUrl 换成硬编码照样绿。 */
{
  const alt = HOST + "/api/haminn/jobs";
  arm({ document: doc((copy) => {
    copy.endpoints.jobs = "/api/haminn/jobs";
    copy.endpoints.progress = "/api/haminn/jobs/{job_id}/progress";
    copy.endpoints.job = "/api/haminn/jobs/{job_id}";
  }) });
  replies[alt] = replies[JOBS];
  replies[alt + "/" + JOB_ID + "/progress"] = replies[PROGRESS_URL];
  replies[alt + "/" + JOB_ID] = replies[STATUS_URL];
  delete replies[JOBS];
  delete replies[PROGRESS_URL];
  delete replies[STATUS_URL];

  await prime();
  await providers.generate(card("render"), { prompt: "p", seed: 1 });

  assert.ok(asked.indexOf(alt) >= 0, "提交要打到文档新公布的 jobs 地址");
  assert.equal(asked.indexOf(JOBS), -1, "不许再打旧的 /chp/jobs");
  assert.ok(asked.indexOf(alt + "/" + JOB_ID + "/progress") >= 0, "轮询也要跟着文档走");
  assert.ok(asked.indexOf(alt + "/" + JOB_ID) >= 0, "取状态也要跟着文档走");
}

/* 3) 画幅由**帧表**决定,不由卡里存的数决定,也不是算出来的。
      (a) 帧表把 render 的 9:16 改成 720x1280 ⇒ 发 720x1280(卡里存的还是出厂 768x1344);
      (b) render 的 9:16 有两档 ⇒ 卡里存的那条还在表里就沿用它(那是用户的选择),
          不在表里(插件改了表)就退回表里第一条;
      (c) 同一条 9:16 帧里给了多个分辨率 ⇒ 取第一个;
      (d) render 的帧表里还摆着 21:9 / 3:4 这些长方档 ⇒ 一条都不该被选中
          (锁了竖幅之后拿一条横的回去,插件会用 stretched_reference 当场拒绝)。 */
{
  arm({ document: doc(onlyFrames("render", [{ ratio: "9:16", resolution: ["720x1280"], category: "render" }])) });
  await prime();
  await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.equal(posted[0].resolution, "720x1280", "帧表说了算,卡里那个 768x1344 不在表里就不作数");

  arm({ document: doc(onlyFrames("render", [
    { ratio: "9:16", resolution: ["720x1280", "540x960"], category: "render" }])) });
  await prime();
  const kept = card("render");          // 出厂 resolution 是 768x1344,不在新表里
  await providers.generate(kept, { prompt: "p", seed: 1 });
  assert.equal(posted[0].resolution, "720x1280", "卡里那条不在表里 ⇒ 退回表里第一条");

  const chosen = card("render");
  chosen.resolution = "540x960";        // 这次它**在**表里
  await providers.generate(chosen, { prompt: "p", seed: 1 });
  assert.equal(posted[1].resolution, "540x960", "卡里那条还在表里 ⇒ 沿用用户挑的那一条");

  /* 帧表里同时有横档与竖档:只挑竖的,而且挑的是帧表里那一个字面量 */
  arm();
  await prime();
  await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.equal(posted[0].resolution, "768x1344",
    "真夹具里 render 的 9:16 只有这一档 —— 21:9(1536x640)与 3:4(832x1152)都不该被选中");
}

/* 4) 参考图基准取**规则自报**的 defaults.ref_strength(插件改默认时本应用不用跟着发版)。
      两边都验:照夹具的 0.55、改过的 0.40、以及"插件没报"时的出厂回落。 */
{
  arm();
  await prime();
  assert.equal(internals.refStrength01({ task: "fast", refStrength: 100 }), 0.55, "100 对齐规则自报的基准");
  assert.equal(internals.refStrength01({ task: "render", refStrength: 100 }), 0.95, "每个场景有自己的基准");

  arm({ document: doc((copy) => {
    copy.rules.filter((rule) => rule.category === "fast")[0].defaults.ref_strength = 0.40;
  }) });
  await prime();
  assert.equal(internals.refStrength01({ task: "fast", refStrength: 100 }), 0.40, "基准换了要跟着换");

  arm({ document: doc((copy) => {
    delete copy.rules.filter((rule) => rule.category === "fast")[0].defaults.ref_strength;
  }) });
  await prime();
  assert.equal(internals.refStrength01({ task: "fast", refStrength: 100 }),
    app.defaults.chpTasks.fast.refBase, "插件没自报时退回出厂表");
}

/* 5) `job.ignored` 一旦非空,就要报给用户看一眼。
      本应用现在发的都是插件认的字段(第 1 条已证),但这条回执正是"某个字段改名之后
      这边没跟着改"唯一能被看见的地方 —— 把它扔掉的代价就是静默失效。 */
{
  arm();
  replies[JOBS] = { status: 202, bodyText: JSON.stringify({
    job: { id: JOB_ID, category: "render", state: "queued", queue_position: 0, ignored: ["capability", "steps"] } }) };
  const lines = [];
  app.events.on("generation:progress", (detail) => { if (detail.stage === "submit") lines.push(detail.detail); });
  await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.ok(lines.some((line) => line.indexOf("capability") >= 0 && line.indexOf("steps") >= 0),
    `被忽略的字段要点名报出来,收到:${JSON.stringify(lines)}`);
}

/* 6) 进度文案照**队列位置**说 —— 插件不报百分比(真机上 progress 恒为 null),
      编一个假的比 null 更糟。 */
{
  arm();
  replies[PROGRESS_URL] = [
    { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "queued", queue_position: 3, progress: null } }) },
    { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "running", queue_position: 0, progress: null } }) },
    { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "completed", queue_position: null, progress: null } }) }
  ];
  const details = [];
  app.events.on("generation:progress", (detail) => { if (detail.stage === "running") details.push(detail.detail); });

  await providers.generate(card("render"), { prompt: "p", seed: 1 });

  assert.ok(details.some((line) => line.indexOf("3") >= 0), `排队时要报出前面还有几个,收到:${JSON.stringify(details)}`);
  assert.ok(details.some((line) => line.indexOf("3") < 0 && line.indexOf("进行中") >= 0),
    `轮到自己时不能再提队列位置,收到:${JSON.stringify(details)}`);
}

/* 7) 失败要当场抛,而且要把 `job.error` 那句原话取回来(轻的 /progress 里没有它);
      取消同理。 */
{
  arm();
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "failed", progress: null } }) };
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "failed", error: "node 12 not found" } }) };
  let message = "";
  try { await providers.generate(card("render"), { prompt: "p", seed: 1 }); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("工作流执行失败") >= 0, `失败要报出来,收到:${message}`);
  assert.ok(message.indexOf("node 12 not found") >= 0, `失败原因要取回来,收到:${message}`);

  arm();
  replies[PROGRESS_URL] = { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "cancelled", progress: null } }) };
  message = "";
  try { await providers.generate(card("render"), { prompt: "p", seed: 1 }); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("已取消") >= 0, `取消要报出来,收到:${message}`);
}

/* 8) 完成后没有成图 ⇒ 报错,不能返回一个空 src */
{
  arm();
  replies[STATUS_URL] = { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "completed", outputs: [] } }) };
  await assert.rejects(() => providers.generate(card("render"), { prompt: "p", seed: 1 }), /没有图片输出/);
}

/* 9) 协议大版本对不上要当场停下。
      `spec` 只承诺"同版本内只加不删",跨版本拿旧规则继续猜,请求体可能只是被忽略 ——
      那比报错更难查。(这条正是本应用这一轮从 chp/1 换到 chp/2 的现场。) */
{
  arm({ document: doc((copy) => { copy.spec = "chp/1"; }) });
  let message = "";
  try { await prime(); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("chp/1") >= 0 && message.indexOf("chp/2") >= 0,
    `两个版本号都要报出来,收到:${message}`);
  assert.ok(message.indexOf("升级") >= 0 || message.indexOf("配套") >= 0,
    `要告诉用户怎么办,收到:${message}`);
}

/* 9b) 上面的闸门只在**读过一份版本不同的文档**之后才成立。
       反过来说:没有文档可比时照发,由服务端回绝 —— 这条保证第 9 条不是"任何情况下
       都拦住"那种永远为真的断言。 */
{
  arm();
  await prime();                      // 这一份是 chp/2,闸门放行
  await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.equal(posted[0].category, "render", "版本对得上就要照发");
}

/* 10) 没有密码时不发 `chp_params`(密码留空 = 插件侧关闭鉴权)。
       发一个空串在某些实现里会被当成"填了但不对"。 */
{
  arm();
  const open = card("render");
  open.apiKey = "";
  await providers.generate(open, { prompt: "p", seed: 1 });
  assert.equal(posted[0].chp_params, undefined, "没有密码就整个不发这个通道");
  assert.equal(posted[0].category, "render");
}

/* 11) **生成前自检**(2026-09-30 用户要求:「每次点击生成图片之前,先检测当前选定的
       模型是否能正常使用,如果不能正常使用,就弹窗提示用户去设置模型」)。
       `preflight` 不抛、只回 { ok, reason },调用方据此弹窗 —— 这里四条:
         (a) 没有模型卡;
         (b) 地址是空的(本地 validate 就拦下,一个字节都不发);
         (c) 插件的帧表里没有这个场景的 9:16;
         (d) 一切正常 ⇒ 真的去问了一次插件(INFO_URL),而且用的是**自检自己的超时**。
       最后一条是这组里最容易写软的一处:只断言 ok === true 的话,把远端那一步整段删掉
       照样绿 —— 所以这里同时钉住"确实打了信息接口"和"超时用的是那个短的"。 */
{
  const noCard = await providers.preflight(null);
  assert.equal(noCard.ok, false, "没有模型卡 ⇒ 不能发");
  assert.ok(noCard.reason.length > 0, "要说清为什么");

  const blank = card("render");
  blank.endpoint = "";
  const noAddress = await providers.preflight(blank);
  assert.equal(noAddress.ok, false, "地址为空 ⇒ 不能发");
  assert.ok(noAddress.reason.length > 0, "要说清为什么");

  arm();
  await prime();
  const noPortrait = await providers.preflight(card("fast"));
  assert.equal(noPortrait.ok, false, "帧表里没有 9:16 ⇒ 不能发");
  assert.ok(noPortrait.reason.indexOf("9:16") >= 0, `要说清缺的是 9:16,收到:${noPortrait.reason}`);

  arm();
  const ready = await providers.preflight(card("render"));
  assert.equal(ready.ok, true, `自检该放行,收到:${ready.reason}`);
  assert.ok(asked.indexOf(INFO_URL) >= 0, "自检要真的问一次插件,不能只看本地配置");
  const probes = sent.filter((item) => item.url === INFO_URL);
  assert.ok(probes.length > 0, "要打过信息接口");
  assert.equal(probes[0].timeoutMs, 8000,
    "自检用自己那个短超时,不是卡上的 300000 —— 地址填错时不该让用户等五分钟");

  /* 反面:远端不通时必须返回 ok:false,而不是把异常漏出去 */
  arm();
  replies[INFO_URL] = { status: 502, bodyText: JSON.stringify({ error: "boom" }) };
  const broken = await providers.preflight(card("render"));
  assert.equal(broken.ok, false, "插件答不上来 ⇒ 不能发");
  assert.ok(broken.reason.length > 0, "要说清为什么");
}

/* 12) **等待期间一次瞬时故障不许判死整次生成**(2026-09-30 真机现场)。
       真机上发生过:一次生成等了 80 多秒后只报一句「内部错误」,而服务端的作业其实
       已经跑完、图也已经落盘 —— 手机文件库里连一个字节都没有,那张图永远没人来取。
       成因见 app/services/providers.js 里 chpReadQuiet 那段注释(宿主读响应体那段
       没把网络超时包成 HaminnException)。这一组守住四件事:
         (a) 轮询失败一次 ⇒ 补问一次,照样跑完、图照样拿到;
         (b) 取图失败一次 ⇒ 同样补取,不白扔;
         (c) 插件**明确拒绝**(密码不对)⇒ 一次都不重试,立刻报出来;
         (d) 提交(差点忘了这条)一次都不重试 —— 重试它会在服务端多排一个作业。
       断言落在**请求条数**上:"只报不重试"这种毛病只有计数看得见。 */
{
  /* (a) 轮询头一次抛「内部错误」,第二次才给终态 */
  arm();
  await prime();
  replies[PROGRESS_URL] = [
    { throws: "内部错误", code: "E_INTERNAL" },
    { status: 200, bodyText: JSON.stringify({ job: { id: JOB_ID, state: "completed", queue_position: null, progress: null } }) }
  ];
  const recovered = await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.equal(recovered.logicalFileId, "lf-chp-1", "轮询瞬时失败后仍要把图拿回来");
  assert.equal(sent.filter((item) => item.url === PROGRESS_URL).length, 2,
    "失败的那一次要补问一次(只问一次就是没重试)");
  assert.equal(sent.filter((item) => item.url === JOBS).length, 1, "提交成功了就不该再发一次");

  /* (b) 取图那一次失败 ⇒ 同样补取,不能把已经生成好的图扔掉 */
  arm();
  await prime();
  replies[OUTPUT_URL] = [
    { throws: "内部错误", code: "E_INTERNAL" },
    { status: 200, bodyText: "", file: { url: "haminn://blob/chp-1", logicalFileId: "lf-chp-1" } }
  ];
  const fetched = await providers.generate(card("render"), { prompt: "p", seed: 1 });
  assert.equal(fetched.logicalFileId, "lf-chp-1", "取图瞬时失败后仍要拿到图");
  assert.equal(sent.filter((item) => item.url === OUTPUT_URL).length, 2, "失败的那一次要补取一次");

  /* (c) 反过来:插件明确拒绝(密码不对)不许重试 —— 同样的结果,白白拖长等待 */
  arm();
  await prime();
  replies[PROGRESS_URL] = { status: 401, bodyText: JSON.stringify({ error: "unauthorized" }) };
  let refused = "";
  try { await providers.generate(card("render"), { prompt: "p", seed: 1 }); } catch (error) { refused = String(error.message); }
  assert.ok(refused.indexOf("密码") >= 0, `密码不对要照旧报出来,收到:${refused}`);
  assert.equal(sent.filter((item) => item.url === PROGRESS_URL).length, 1,
    "明确拒绝的错误只问一次(重试它不会换一个结果)");

  /* (d) 提交失败**可以**重发,但两次必须带**同一个提交编号** ——
         这就是"重发安全"的全部理由(chp/2 的 `request_id`):同键重发,插件把原来
         那个作业还回来,不会再排一个。万一两次的键不一样,服务端就会多画一张,
         而这里是唯一会发现的地方。 */
  arm();
  await prime();
  replies[JOBS] = { status: 502, bodyText: JSON.stringify({ error: "boom" }) };
  let submitFailed = "";
  try { await providers.generate(card("render"), { prompt: "p", seed: 1 }); } catch (error) { submitFailed = String(error.message); }
  assert.ok(submitFailed.length > 0, "提交失败要报出来");
  assert.equal(posted.length, 2, "瞬时失败要重发一次(有上限,不是无限)");
  assert.equal(typeof posted[0].request_id, "string", "提交体必须带幂等键");
  assert.ok(posted[0].request_id.length > 0, "幂等键不能是空串");
  assert.equal(posted[0].request_id, posted[1].request_id,
    "两次提交的键必须一模一样 —— 换了键就等于让服务端多排一个作业");
  const strip = (body) => { const copy = Object.assign({}, body); delete copy.request_id; return copy; };
  assert.deepEqual(strip(posted[1]), strip(posted[0]),
    "除去键以外的部分不许变:重发的必须是同一次提交");
  assert.equal(sent.filter((item) => item.url === PROGRESS_URL).length, 0, "提交没过就不该开始轮询");

  /* (d2) 但插件**明确拒绝**的提交照旧不重发 —— 密码不对,重发一万次也是同一个结果 */
  arm();
  await prime();
  replies[JOBS] = { status: 401, bodyText: JSON.stringify({ error: "unauthorized" }) };
  let refusedSubmit = "";
  try { await providers.generate(card("render"), { prompt: "p", seed: 1 }); } catch (error) { refusedSubmit = String(error.message); }
  assert.ok(refusedSubmit.indexOf("密码") >= 0, `密码不对要照常报出来,收到:${refusedSubmit}`);
  assert.equal(posted.length, 1, "终态错误不许重发提交");

  /* (e) 重试是**有界**的:一直失败就到上限为止,不能无限等下去。
         直接问这个函数而不是走整条链路 —— 走链路它要轮询到卡上的 300 秒超时。 */
  arm();
  replies[INFO_URL] = { throws: "内部错误", code: "E_INTERNAL" };
  await assert.rejects(
    () => internals.chpReadQuiet({ url: INFO_URL, method: "GET", headers: {}, timeoutMs: 8000 }),
    /内部错误/);
  assert.equal(sent.filter((item) => item.url === INFO_URL).length, 3, "瞬时故障最多重试到 3 次");

  /* (f) "哪些错不值得重试"这条判据本身:那句「内部错误」没有任何信息量,只能当瞬时;
         插件明确拒绝的那几种,再问一万次也是同一个结果。 */
  assert.equal(internals.chpTerminal(new Error("内部错误")), false, "无信息量的兜底文案要当瞬时故障");
  assert.equal(internals.chpTerminal(new Error("E_INTERNAL")), false, "靠错误码也认不出它是不是终态");
  assert.equal(internals.chpTerminal(new Error("HTTP 401")), true, "密码不对是终态");
  assert.equal(internals.chpTerminal(new Error("服务端错误(500):unsupported_size")), true, "画幅不接受是终态");
  assert.equal(internals.chpTerminal(new Error("插件工作流执行失败:node 12 not found")), false,
    "工作流失败是**作业**的终态(由 state=failed 报),不是这条通信的终态");
}

console.log("chp-jobs.test.mjs: ok (category、9:16 帧表、没有竖幅时当场拦下、ext_params 两个键、"
  + "chp_params 密码、地址读 endpoints、ignored 点名、队列位置文案、失败取原因、spec 闸门、"
  + "顶层键全在 schema 里、生成前自检四条、等待期间只读请求的有界重试)");
