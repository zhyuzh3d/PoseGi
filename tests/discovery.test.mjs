/* CHP 的自描述(`GET {base}/chp/info`)
 *
 * 插件按 `chp/2` 规范自报一张文档,客户端的「测试连接」由此变成一次真正的读取。
 * 这组断言锁六件事,每一件错了都会静默出错图或给出误导性提示:
 *
 *   1. **一次请求**打到信息接口,而且地址归一化要收得住三种写法(裸源、`…/chp`、
 *      `…/chp/info`)。旧根 `/cvp` 与 `/hamdraw/v1` 在 chp/2 里已经 **404**,
 *      客户端只做前缀归一(切成服务根再拼推荐路径),不再把它们当"另一个根"。
 *   2. 卡上的场景名要落到 `rules[].category` 上 —— **没有别名可翻**:`chp/2` 取消了
 *      别名机制,表里没有的名字就是"没有",该提示升级插件,而不是发出去等 400。
 *   3. 画幅与步数**只读不报**:`resolution` 是从 `abilities[].frames` 挑出来的那一档
 *      (2026-09-30 起本应用锁 9:16,所以**只挑标着 `9:16`** 的那些),`resolutions`
 *      是给界面看的多档备选。表里没有竖幅就是一条空清单 —— 那台插件上这个场景
 *      **出不了图**(真机上 fast / upscale 就是这种情况);
 *      `chp/2` 不公布步数枚举(步数是实现的 `ext_params` 扩展键),所以不再有 `steps` 这一项。
 *   4. 模型信息来自 `abilities[].files`(**挂载点**),不再是 `models[].name` ——
 *      一条能力可以是一组文件(高质量生图那路是三件套),谁也不能只挑一个当它的名字。
 *   5. `rules[].prompt.language` 要如实变成 `englishOnly`;没声明这一项时必须给 null,
 *      让界面别去动用户手工拨的开关(猜错方向就会把中文提示词喂给只认英文的编码器)。
 *   6. 地址通但密码错、地址不是这个插件、协议大版本对不上、能力没装好 —— 四件事要分开报。
 *
 * 夹具是 A1X 真机抓下来的那一份,缘由见 chp-jobs.test.mjs 顶部。
 * providers.js 在加载时就把 app.platform.haminn 抓成局部变量,所以宿主替身必须在
 * 加载它**之前**挂上去,这组测试不跟别的用例共用加载段。
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
app.platform.haminn = {
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

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/chp-info-3.0.2.json"), "utf8"));

function doc(mutate) {
  const copy = JSON.parse(JSON.stringify(FIXTURE));
  if (mutate) mutate(copy);
  return copy;
}

const HOST = "http://192.168.1.31:8189";
const BASE = HOST + "/chp";
const INFO_URL = BASE + "/info";

/* 一张卡。地址留空由调用方填,好把归一化那几条分开测。 */
function card(task, endpoint) {
  const value = providers.preset("chp", task);
  value.endpoint = endpoint || BASE;
  value.apiKey = "test-chp-password";
  return value;
}
/* 走一次「测试连接」并返回结果 */
async function probe(document, task, endpoint) {
  asked = [];
  routes = {};
  routes[INFO_URL] = { status: 200, body: document || FIXTURE };
  return providers.test(card(task || "fast", endpoint));
}

/* 1) 读到的是**插件报的那几个事实**(不是本应用自己算的)。
      主角是 render:这台插件上**只有它**公布了 9:16。 */
{
  const render = await probe(FIXTURE, "render");
  assert.deepEqual(asked, [INFO_URL],
    "填的地址就是根路径 `…/chp` 时,推荐路径是确定的 —— 一次就该问到,不要先白打一遍根路径");
  assert.equal(render.ok, true);
  assert.equal(render.spec, "chp/2", "协议版本要如实报上来");
  /* 版本号来自 fixture 自己那一份,不是写死的字面量 —— 断言的是"客户端读的是
     plugin.version 这个字段",而不是"插件恰好是某一版"(那随每次部署就过期) */
  assert.equal(render.version, FIXTURE.plugin.version, "插件版本来自 plugin.version");
  assert.equal(render.category, "render", "场景名就是规则表里的 category");
  assert.equal(render.capability, undefined, "chp/2 没有能力名这个东西");
  assert.equal(render.resolution, "768x1344", "本应用真正会发出去的那一条(9:16 那档的第 0 条)");
  assert.deepEqual(render.resolutions, ["768x1344", "576x1024", "432x768"],
    "render 公布的 9:16 就是这三档、这个顺序 —— 那七条横的竖的(21:9、3:4…)一条都别进来");
  assert.equal(render.englishOnly, false, "render 声明 language:any,中文也照画");
  assert.equal(render.model, "qwen2.1", "模型来自 abilities[].name");
  assert.equal(render.fileMap.unet, "qwen_image_2.1_int8_convrot.safetensors");
  assert.equal(render.fileMap.clip, "qwen3vl_8b_int8_convrot.safetensors");
  assert.equal(render.fileMap.vae, "qwen_image_2.1_vae_bf16.safetensors");
  assert.ok(render.files.indexOf("unet") >= 0 && render.files.indexOf("vae") >= 0,
    "三件套要一起报出来,不能只挑一个当名字");

  /* fast / upscale:场景在册、文件装好、就是**没有竖幅** —— 锁 9:16 之后它们出不了图。
     这组断言是"浏览器一边挑不出来就当场说清"的前提(挑的动作见 chp-jobs 第 1b 条)。 */
  const fast = await probe(FIXTURE, "fast");
  assert.equal(fast.category, "fast");
  assert.equal(fast.model, "DreamShaper8_LCM.safetensors");
  assert.equal(fast.fileMap.checkpoint, "DreamShaper8_LCM.safetensors", "挂载点要原样带出来");
  assert.deepEqual(fast.resolutions, [], "fast 只有 1:1 / 4:3 / 3:4,一条 9:16 都没有");
  assert.equal(fast.resolution, "", "挑不出来就是空串 —— 调用方据此说清是哪一种缺");
  assert.equal(fast.englishOnly, true, "fast 声明 language:en,中文要先译英");
  assert.equal(fast.authRequired, true);
  assert.equal(fast.authorized, true);
  assert.equal(fast.ready, true);

  const upscale = await probe(FIXTURE, "upscale");
  assert.equal(upscale.category, "upscale");
  assert.deepEqual(upscale.resolutions, [], "upscale 只有两档正方,同样没有竖幅");
  assert.equal(upscale.resolution, "");

  /* 帧表是**按 category 找**的,不是写死哪几个场景:给 inpaint 塞一档 9:16,它就出得来
     (本应用现在没有这个场景的卡,但"读得到"这件事要留在接口上,将来加卡不用改这里)。 */
  await probe(doc((copy) => {
    copy.abilities.forEach((ability) => {
      const others = ability.frames.filter((frame) => frame.category !== "inpaint");
      if (others.length === ability.frames.length) return;
      ability.frames = others.concat([{ ratio: "9:16", resolution: ["576x1024"], category: "inpaint" }]);
    });
  }), "render");
  assert.deepEqual(providers.internals.chpResolutions("inpaint"), ["576x1024"],
    "inpaint 的帧也要能读,而且只挑标着 9:16 的那条");
  assert.equal(providers.internals.chpResolutions("wipe").length, 0, "不认识的场景没有帧");
}

/* 1b) 界面上的**场景清单与它们的名字、说明也来自插件**。
   `chp/2` 的 `rules[]` 就是这份清单(除 `category` / `rule` 以外都是可选键,客户端
   按需读、读不到才用自己那份 —— 见 chp-v2-plan §1.2),所以这里断的是"插件说了算",
   不是"能读出来":改了插件那句话,界面就该跟着变,不用等本应用改版。
   以前这三样各写死在前端一份,与插件播报的**逐字相同** —— 那是两份会漂移的事实。 */
{
  await probe(FIXTURE, "render");
  assert.deepEqual(providers.internals.chpCategories(), ["fast", "upscale", "render"],
    "清单就是插件播报的那几条、顺序也照它;没有 inpaint —— 它 needs.mask=true,本应用只做整张重画");
  assert.equal(providers.internals.taskName("fast"), "快速生图", "名字取插件给的 label");
  assert.equal(providers.internals.taskName("upscale"), "图像放大");
  assert.equal(providers.internals.taskName("render"), "高质量生图");
  assert.equal(providers.internals.taskDescription("render"),
    "重画成一张 1024 以内的成品图。比速写模型重得多, 单张要几十秒。",
    "说明也取插件给的那句 —— 前端那一份只是没读到插件时的兜底");
  assert.equal(providers.internals.chpKnown("render"), true);
  assert.equal(providers.internals.chpKnown("wipe"), false, "插件没播报过的词还是不认");

  /* 插件换了说法 / 多播报一个不需要蒙版的场景 ⇒ 界面自己跟上 */
  await probe(doc((copy) => {
    copy.rules = copy.rules
      .map((rule) => (rule.category === "render"
        ? Object.assign({}, rule, { label: { zh: "成品图", en: "Finished picture" }, description: { zh: "按参考图重画。", en: "Repaint from the reference." } })
        : rule))
      .concat([{ category: "portrait", rule: "txt-ref-2-img", needs: { prompt: true, image: true, mask: false } }]);
  }), "render");
  assert.equal(providers.internals.taskName("render"), "成品图", "插件改了名字,界面跟着改");
  assert.equal(providers.internals.taskDescription("render"), "按参考图重画。");
  assert.deepEqual(providers.internals.chpCategories(), ["fast", "upscale", "render", "portrait"],
    "新增的场景自己出现在清单里(它没要蒙版)");
  assert.equal(providers.internals.chpKnown("portrait"), true,
    "配置层也要认它,否则卡上选了这个场景会被悄悄改回 fast");
}

/* 2) 卡上的场景名插件不认(比如插件还是旧版)⇒ 提示升级,而不是发出去等 400 */
{
  let message = "";
  try { await probe(doc((copy) => {
    copy.rules = copy.rules.filter((rule) => rule.category !== "render");
    copy.abilities.forEach((ability) => {
      ability.frames = ability.frames.filter((frame) => frame.category !== "render");
    });
  }), "render"); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("请升级") >= 0 || message.indexOf("不支持") >= 0,
    `场景不在册要提示升级,收到:${message}`);
  assert.ok(message.indexOf("升级") >= 0, `并且要说清怎么办,收到:${message}`);
}

/* 3) 场景在册但**回答它的那组文件**没装好 ⇒ 要拦住,否则提交时才被 409 顶回来。
      注意判据挂在 `abilities[].ready` / `.missing` 上,不是挂在场景上。 */
{
  let message = "";
  try { await probe(doc((copy) => {
    copy.abilities.forEach((ability) => {
      if (ability.frames.some((frame) => frame.category === "render")) {
        ability.ready = false;
        ability.missing = ["unet", "vae"];
      }
    });
  }), "render"); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("没有为") >= 0 || message.indexOf("没装好") >= 0 || message.indexOf("模型") >= 0,
    `文件没装好要说清,收到:${message}`);
  assert.ok(message.indexOf("unet") >= 0 && message.indexOf("vae") >= 0,
    `缺了哪几个要点名,收到:${message}`);
}

/* 3b) 连"回答这个场景的模型组"都没有(规则在、能力表里没有对应帧)⇒ 另一句话 */
{
  let message = "";
  try { await probe(doc((copy) => {
    copy.abilities = copy.abilities.filter((ability) =>
      !ability.frames.some((frame) => frame.category === "render"));
  }), "render"); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("模型组") >= 0 || message.indexOf("没有能回答") >= 0,
    `没有回答者要说清是配置问题,收到:${message}`);
}

/* 4) 三个场景的 `prompt.language` 都要如实传上来;没声明时必须给 null ——
      界面据此保留用户的手工开关,而不是替它猜。 */
{
  assert.equal((await probe(FIXTURE, "fast")).englishOnly, true, "en ⇒ true");
  assert.equal((await probe(FIXTURE, "render")).englishOnly, false, "any ⇒ false");
  assert.equal((await probe(doc((copy) => {
    delete copy.rules.filter((rule) => rule.category === "fast")[0].prompt;
  }), "fast")).englishOnly, null, "没声明语言就不能替用户猜");
}

/* 5) 地址归一化:用户存过的每一种写法都要收口到同一个信息接口。
      (a) 根路径那几种(`…/chp`、`…/chp/`、`…/chp/info`、更名前的 `…/cvp`、
          `…/hamdraw/v1`)能推出推荐路径 ⇒ **一次**就问对;
      (b) 裸源(只有 host:port)推不出来 ⇒ 按契约先用原样那条,不成再试推荐路径;
      (c) "主机名恰好以 chp 开头"不能被当成根路径切掉。 */
{
  for (const endpoint of [BASE, BASE + "/", BASE + "/info", HOST + "/cvp", HOST + "/hamdraw/v1"]) {
    asked = [];
    routes = {};
    routes[INFO_URL] = { status: 200, body: FIXTURE };
    const result = await providers.test(card("fast", endpoint));
    assert.equal(result.ok, true, `${endpoint} 应该能读到文档`);
    assert.deepEqual(asked, [INFO_URL], `${endpoint} 该一次收口到 ${INFO_URL},收到 ${JSON.stringify(asked)}`);
  }

  asked = [];
  routes = {};
  routes[HOST] = { status: 200, body: { hello: "ComfyUI web root" } };
  routes[INFO_URL] = { status: 200, body: FIXTURE };
  await providers.test(card("fast", HOST));
  assert.deepEqual(asked, [HOST, INFO_URL], "裸源要先按原样问一次,再试推荐路径");

  asked = [];
  routes = {};
  routes["http://chp-host.local:8188/chp/info"] = { status: 200, body: FIXTURE };
  await providers.test(card("fast", "http://chp-host.local:8188"));
  assert.deepEqual(asked, ["http://chp-host.local:8188", "http://chp-host.local:8188/chp/info"],
    "主机名里的 chp 不算根路径,不能被切成 http:///info 之类的荒谬地址");
}

/* 6) 地址通、密码错:要说清是密码的问题,而不是笼统的"连接失败" */
{
  let message = "";
  try { await probe(doc((copy) => { copy.auth.authorized = false; })); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("访问密码不对") >= 0, `密码错要单独说清,收到:${message}`);
  assert.ok(message.indexOf("已连通") >= 0, `还要说明地址是通的,收到:${message}`);
}

/* 6b) 插件侧关掉了鉴权(required:false)⇒ 不该报密码错。
       判据是 `required === true && authorized === false`,只看 authorized 会把
       "没有鉴权"说成"密码不对"。 */
{
  const result = await probe(doc((copy) => { copy.auth.required = false; copy.auth.authorized = false; }));
  assert.equal(result.ok, true, "关掉鉴权是正常状态");
  assert.equal(result.authRequired, false);
}

/* 7) 协议大版本对不上:两个版本号都要报出来,并且要说清怎么办 */
{
  let message = "";
  try { await probe(doc((copy) => { copy.spec = "chp/3"; })); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("chp/3") >= 0 && message.indexOf("chp/2") >= 0,
    `两个版本号都要报出来,收到:${message}`);
}

/* 8) 地址根本不是这个插件:要说是地址的问题,别假装密码错 */
{
  let message = "";
  try { await probe({ hello: "world" }); } catch (error) { message = String(error.message); }
  assert.ok(message.indexOf("CHP") >= 0, `要说清在找的是 CHP,收到:${message}`);
  assert.ok(message.indexOf("不是 CHP 服务") >= 0, `要说是地址问题,收到:${message}`);
}

/* 9) 非 CHP 协议不走自描述 —— 别把别的服务也拿去问 /chp/info */
{
  asked = [];
  routes = {};
  routes[HOST + "/sdapi/v1/sd-models"] = { status: 200, body: [] };
  const sd = providers.preset("sd-webui", "fast");
  sd.endpoint = HOST;
  const result = await providers.test(sd);
  assert.equal(result.ok, true);
  assert.deepEqual(asked, [HOST + "/sdapi/v1/sd-models"], "SD WebUI 还是问它自己的模型列表");
}

console.log("discovery.test.mjs: ok (一次自描述、category 无别名、画幅只读帧表里 9:16 那一档、"
  + "没有竖幅就是空清单、模型来自 files、语言如实上报、密码/身份/版本分开报、地址归一化)");
