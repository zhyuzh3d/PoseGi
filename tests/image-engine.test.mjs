/* 生图编排:提交时提示词怎么组(前缀 + 自动译英),以及前缀**不进作品记录**
 *
 * 2026-09-30 用户要求:「提交生成时,提示词开头加一句:参考图1只做姿势参考,
 * 不要使用参考图中人物的人物外形、发型或服饰等任何外部特征」。
 *
 * 这条为什么值得一条端到端断言:整件事横跨四段(作品提示词 → prepare 的自动译英 →
 * 前缀 → providers.generate 收到的那份 input → store 记下的 prompt)。
 * 中间任何一段断了,表现都是"模型照着参考图的人样画了一个人" —— 而日志里、
 * 界面上都看不出来,单测里只断言"有一个 POSE_PREFIX 常量"更是照样绿。
 * 所以断言只打在**最外面两处**:
 *   1) 发给模型的那份以那句开头,用户写的内容一字不动地跟在后面;
 *   2) 记进作品的那份**不含**那句(它是调用参数,不是用户写的内容)。
 *
 * 另一半是**提交时到底发哪一份提示词**(2026-09-30 用户定稿):
 *   「如果模型需要翻译为英文,那么,如果配置了翻译模型,每次提交的时候 PoseGi 就自动使用
 *    这个翻译模型进行翻译,然后缓存备用避免下次同样内容重复调用模型翻译,把翻译结果直接
 *    发给生图模型使用;如果没有配置翻译模型,就在提示词输入框添加（请使用英文,或软件设置
 *    中增加翻译模型）。」「实际上 CHP 内部可以对模型的工作流添加翻译节点,就是说 CHP
 *    提供的模型都可以视为不需要中文翻译英文。」
 * 于是判据是四件事:① 界面中文;② 这张卡标了要英文;③ **它不是 CHP 卡**;④ 译英服务配好了。
 * 四条里少判一条,或把"自动翻"整段删掉,**在界面上都看不出任何差别** ——
 * 只有"发了几个请求""发出去的是哪一句话"看得见,所以这一组把宿主请求**计数**着挡。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
/* i18n.setLanguage 会顺手写 documentElement.lang / dataset.theme —— 这里只要一个
   能接住赋值的壳子即可(测试不关心 DOM,只关心它选出来的是哪一种语言)。 */
globalThis.document = globalThis.document || { documentElement: { dataset: {} } };
/* namespace.js 会把 app.platform 重置成空对象,所以替身挂在它之后;
   image-engine 自己不碰 platform,但它用的 translate 会碰。 */
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/translate.js", "app/services/image-engine.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const engine = app.services.imageEngine;
const translate = app.services.translate;

/* ---------- 宿主替身 ----------
   译英接口的答复由 translateReply 控制(形状按 OpenAI 兼容那一支:choices[0].message.content)。
   它为空时**一律不许发请求** —— "该不该出去一个请求"是这一组最关键的判据,
   而它一旦被改错(少发一次 / 多发一次),画面上一点变化都没有,只有计数拦得住。 */
let networkCalls = 0;
let translateReply = null;
app.platform.haminn = {
  getData: async () => null,
  putData: async () => ({ collection: "", key: "", value: null }),
  deleteData: async () => ({ deleted: true }),
  request: async (options) => {
    networkCalls += 1;
    if (!translateReply) throw new Error("这一节不该发网络请求,实发的 URL:" + (options && options.url));
    return { status: 200, bodyText: JSON.stringify(translateReply) };
  }
};

/* 用户原话(逐字)。测试**不复述自己的常量** —— 它要求模块导出的那一句
   与这里相同,于是"改了那句话"与"改了这条要求"必须同时发生。 */
const ZH = "参考图1只做姿势参考，不要使用参考图中角色的人物外形、发型或服饰等任何外观特征。";
const EN = "Reference image 1 is for pose reference only. Do not use any appearance features of the character in the reference image, such as their body shape, hairstyle, or clothing.";

/* 生成链路上三个出口各截一份:发给模型的那份 / 记进作品的那份 / 截图口被调了几次 */
let sent = null;
let recorded = [];
let captures = 0;
let preflightOk = true;
let saves = 0;

/* 译英服务走 OpenAI 兼容那一支:它不需要 providers.internals,替身最短。
   (CHP 那一支的地址要从插件文档里读,归 tests/translate.test.mjs 管。) */
app.config = {
  reference: app.defaults.reference,
  translate: { enabled: true, protocol: "openai", endpoint: "https://api.example.invalid/v1",
    model: "translator", apiKey: "k" },
  connection: { endpoint: "http://example.invalid/chp", apiKey: "", customHeaders: "" }
};

/* 卡按需要现搭。**协议默认给非 CHP** —— 因为 CHP 卡按定稿一律不需要客户端译英,
   拿它当默认会把"该翻的没翻"整类断言变成假绿。 */
function card(over) {
  return Object.assign({ id: "card", name: "卡", protocol: "openai", task: "render",
    endpoint: "https://api.example.invalid/v1", needsEnglish: false }, over || {});
}
let activeCard = card();
const CHP = card({ protocol: "chp", endpoint: "http://example.invalid/chp" });

app.services.providers = {
  active: () => activeCard,
  preflight: async () => (preflightOk ? { ok: true, reason: "" } : { ok: false, reason: "地址不通" }),
  generate: async (model, input) => {
    sent = input;
    return { src: "data:image/png;base64,AAAA", logicalFileId: "" };
  }
};
app.services.assets = { persist: async () => null };
app.services.store = {
  addResult: async (image) => { recorded.push(image); return image; },
  scheduleSave: () => { saves += 1; }
};

engine.init({ capture: async () => { captures += 1; return { dataUrl: "data:image/jpeg;base64,AAAA", mime: "image/jpeg" }; } });

async function runWith(prompt) {
  sent = null;
  captures = 0;
  app.state.prompt = prompt;
  app.state.negativePrompt = "";
  return engine.run();
}
function lastRecord() { return recorded[recorded.length - 1]; }

/* ---------- 1) 中文提示词:前缀是中文那句,原句一字不动跟在后面 ---------- */
{
  app.i18n.setLanguage("zh");
  activeCard = CHP;
  const work = "一个女孩站在海边,傍晚的光";
  await runWith(work);

  assert.ok(sent, "生成要真的发出去(自检通过时不该被拦下)");
  assert.equal(sent.prompt.slice(0, ZH.length), ZH, "发给模型的提示词必须以那句开头");
  assert.equal(sent.prompt.charAt(ZH.length), "\n", "前缀与用户的描述之间要换一行,不能粘成一句");
  assert.equal(sent.prompt.slice(ZH.length + 1), work, "用户写的那句要**一字不动**地跟在后面");
  assert.equal(app.services.imageEngine.posePrefix(work), ZH,
    "模块导出的那句必须与用户原话逐字相同");

  /* 记进作品的那份是**用户写的那句**,前缀不进记录 ——
     它是固定的一行调用参数,存进去只会让成图记录里每一条都带着同一句废话。 */
  assert.equal(recorded.length, 1, "成图要落进作品");
  assert.equal(lastRecord().prompt, work, "记进作品的是描述本身,不含前缀");
  assert.equal(app.state.prompt, work, "作品提示词一个字都不该被改写");
  assert.equal(app.state.promptEn, null, "这张卡不需要译文,就不该凭空挂一对译文");
}

/* ---------- 2) 英文界面 + 空提示词:整段就是英文那句,不许以换行开头 ---------- */
{
  app.i18n.setLanguage("en");
  await runWith("");

  assert.equal(sent.prompt, EN, "空描述时前缀就是全部内容,按界面语言取英文那句");
  assert.equal(sent.prompt.charAt(0), "R", "不许留下一个空行开头");
  assert.equal(lastRecord().prompt, "", "记进作品的是空描述(用户真的没写)");
  app.i18n.setLanguage("zh");
}

/* ---------- 3) 提示词是英文时,前缀也得是英文 ----------
      这一条是整件事最容易做错的地方:按界面语言取(中文界面 + 英文提示词
      ⇒ 中文前缀)看起来也没错,但模型卡要英文时整段提示词是先译成英文的,
      两句话语言不一致会互相干扰。判据是**最终那份提示词**。 */
{
  app.i18n.setLanguage("zh");
  await runWith("a girl standing by the sea, dusk light");
  assert.equal(sent.prompt.slice(0, EN.length), EN, "英文提示词配英文前缀");
  assert.equal(sent.prompt.slice(EN.length + 1), "a girl standing by the sea, dusk light");
}

/* ---------- 4) 有现成英文版本时,前缀挂在**那份英文**前面 ----------
      把这条单独列出来,是因为"取用英文版本"与"补前缀"是两条独立的链路,
      顺序错了(先挂前缀再取英文)就变成"拿着一句带前缀的中文去找译文,永远找不到"。
      这里取的是**作品里存的那一份**(promptEn)—— 重启之后进程缓存空了,靠的正是它;
      故意给一个能用的翻译答复:要是实现绕开 promptEn 去问模型,发出去的就不是这一段了。 */
{
  app.i18n.setLanguage("zh");
  const work = "一个科幻女战士站在雨里";
  const english = "a sci-fi female warrior standing in the rain";
  app.state.promptEn = { source: work, text: english };
  activeCard = card({ needsEnglish: true });
  translateReply = { choices: [{ message: { content: "should never be requested" } }] };

  networkCalls = 0;
  await runWith(work);

  assert.equal(sent.prompt, EN + "\n" + english,
    "取到的英文版本要**整段替换**输入框那份中文,前缀再挂到它前面");
  assert.equal(sent.prompt.indexOf(ZH), -1, "英文提示词里不该混进一句中文");
  assert.equal(sent.prompt.indexOf("should never be requested"), -1,
    "作品里存着现成的一份,就不该丢下它去问模型");
  assert.equal(lastRecord().prompt, english, "记进作品的是真正发出去的那份(与之前那一条规矩一致)");
  assert.equal(networkCalls, 0, "缓存里躺着现成的一份,就不该再去问模型");
  translateReply = null;
}

/* ---------- 5) 没有现成英文版本 ⇒ **自动翻一次**,把译文直接发出去 ----------
      2026-09-30 用户定稿的核心那半句:「如果配置了翻译模型,每次提交的时候 PoseGi 就自动
      使用这个翻译模型进行翻译……把翻译结果直接发给生图模型使用」。
      这是整套机制里最容易"默默失效"的一处:少掉这一步,中文会原样发给一张要英文的卡,
      模型那边画不出东西,而界面上一个字都没提、日志里也不会报错。 */
{
  app.i18n.setLanguage("zh");
  const work = "一句从来没翻过的中文描述";
  const english = "a description that has never been translated before";
  activeCard = card({ needsEnglish: true });
  translateReply = { choices: [{ message: { content: english } }] };

  networkCalls = 0; saves = 0;
  await runWith(work);

  assert.equal(networkCalls, 1, "该翻一次:一个请求出去(多一个少一个都是错)");
  assert.equal(sent.prompt, EN + "\n" + english,
    "把**翻译结果**直接发给生图模型用(不是把中文原样发出去)");
  assert.equal(sent.prompt.indexOf(work), -1, "中文一个字都不该留在发出去的那份里");
  assert.equal(lastRecord().prompt, english, "记进作品的是真正发出去的那份英文");
  assert.deepEqual(app.state.promptEn, { source: work, text: english },
    "译文要存进作品(promptEn)—— 否则「缓存备用」只在进程内活着,重启就重翻一遍");
  assert.equal(saves, 1, "存了译文就该落一次盘(不落盘等于没存)");
  assert.equal(translate.internals.cache[ZH], undefined,
    "那句前缀绝不能进翻译缓存 —— 它是固定的一句,不该被送去翻");
  translateReply = null;
}

/* ---------- 6) 「缓存备用避免下次同样内容重复调用模型翻译」----------
      同一句话再提交一次:**一个请求都不该再出去**。上面那一节已经证明"会翻一次",
      这一节必须证明"只翻一次" —— 少了它,每张图都要多等一个来回,而界面上完全一样。
      先把作品里那份 promptEn 抹掉,单独验进程内 cache 那一级(它在同一次运行里最容易被绕过)。 */
{
  app.i18n.setLanguage("zh");
  const work = "一句从来没翻过的中文描述";
  const english = "a description that has never been translated before";
  app.state.promptEn = null;

  networkCalls = 0;
  await runWith(work);

  assert.equal(networkCalls, 0, "同一句话第二次提交不该再问模型(缓存没起作用)");
  assert.equal(sent.prompt, EN + "\n" + english, "发的还是那一份现成英文");
}

/* ---------- 7) CHP 卡一律不翻(用户定:「CHP 提供的模型都可以视为不需要中文翻译英文」)----------
      判据是"这张卡是不是 CHP",不是"插件会不会译"。CHP 的 translation.mode 本来就是
      auto-on-submit,客户端提前翻一次只是多一个来回;这里锁住"一个请求都没出去"。 */
{
  app.i18n.setLanguage("zh");
  const work = "一个古代剑客站在城墙上";
  activeCard = card({ protocol: "chp", needsEnglish: true });
  /* 就算接口摆在那里能翻,也不许被调用 —— 所以故意给一个可用的答复 */
  translateReply = { choices: [{ message: { content: "an ancient swordsman on the city wall" } }] };

  networkCalls = 0;
  await runWith(work);

  assert.equal(networkCalls, 0, "CHP 卡不该由客户端译英:插件自己会译,提前翻只是多一个来回");
  assert.equal(sent.prompt, ZH + "\n" + work,
    "CHP 卡直接发输入框那份(用户要的是「直接用默认输入」)");
  assert.equal(sent.prompt.indexOf("an ancient swordsman"), -1,
    "那份英文一个字都不该出现在发出去的提示词里");
  assert.equal(app.state.promptEn, null, "不翻就不该凭空挂一对译文");
  translateReply = null;
}

/* ---------- 8) 卡不需要英文 ⇒ 有现成英文版本也不用它,一律发输入框原文 ----------
      用户 2026-09-30 原话:「如果当前激活的生图模型不需要英文翻译,那么中文情况下
      也要去掉所有翻译相关的机制和UI,调用时候直接用默认输入就可以不用管中英文了」。
      这一条判的是**行为**:界面上把提示条与机制藏了、请求里却仍旧换成英文 ——
      那正是最难查的那种分叉(界面上一句话都看不出来)。 */
{
  app.i18n.setLanguage("zh");
  const work = "一个女生在雨里走";
  translate.internals.cache[work] = "a girl walking in the rain";
  activeCard = card({ needsEnglish: false });
  translateReply = { choices: [{ message: { content: "should never be used" } }] };

  networkCalls = 0;
  await runWith(work);

  assert.equal(sent.prompt, ZH + "\n" + work,
    "卡能吃中文 ⇒ 就算缓存里躺着英文版本也不换(用户要的是「直接用默认输入」)");
  assert.equal(sent.prompt.indexOf("a girl walking in the rain"), -1,
    "那份英文一个字都不该出现在发出去的提示词里");
  assert.equal(networkCalls, 0, "卡不要英文,连一次翻译都不该发起");
  translateReply = null;
}

/* ---------- 9) 没有配置翻译模型 ⇒ 原样发 + 一个字都不提(提示只在 label 上)----------
      2026-09-30 用户定:「如果没有配置翻译模型,就在提示词输入框添加（请使用英文,
      或软件设置中增加翻译模型）」。也就是说**界面负责说、提交这条路负责不拦**:
      提示条归 components/translate-hint.js(见 tests/translate-hint.test.mjs),
      这里只证明"没配好也照样把图发出去"。 */
{
  app.i18n.setLanguage("zh");
  const work = "一句没配翻译模型时的中文";
  activeCard = card({ needsEnglish: true });
  app.config.translate = { enabled: false, protocol: "openai", endpoint: "https://api.example.invalid/v1",
    model: "translator", apiKey: "k" };

  networkCalls = 0;
  await runWith(work);

  assert.equal(networkCalls, 0, "译英服务没配好,就不该去试一次(试也白试,还多等一个超时)");
  assert.equal(sent.prompt, ZH + "\n" + work, "照样生成,原样发输入框那份");
  assert.equal(app.state.promptEn, null, "没翻成就不该挂一对译文");

  app.config.translate = { enabled: true, protocol: "openai", endpoint: "https://api.example.invalid/v1",
    model: "translator", apiKey: "k" };
}

/* ---------- 10) 翻译请求失败 ⇒ **绝不拦生成**,退回原文 ----------
      接口不可达、密码不对、模型没加载,一律退回原文交给模型。
      报错拦下就变成"按钮点了没反应",那是比"发了一份中文"更坏的结果。 */
{
  app.i18n.setLanguage("zh");
  const work = "翻译接口挂掉时写的中文";
  activeCard = card({ needsEnglish: true });
  translateReply = null;   /* 宿主替身收到请求就抛 —— 就是"接口不可达"那种 */

  networkCalls = 0;
  await runWith(work);

  assert.equal(networkCalls, 1, "配好了就该试一次(试过才知道不通)");
  assert.ok(sent, "翻不出来也必须出图,不许把生成拦下");
  assert.equal(sent.prompt, ZH + "\n" + work, "退回原文发出去");
  assert.equal(app.state.promptEn, null, "没翻成不写译文");
}

/* ---------- 11) 自检不过 ⇒ 既不截图也不发请求,更不会有半份带前缀的请求漏出去 ---------- */
{
  preflightOk = false;
  activeCard = CHP;
  await runWith("一个女孩");
  assert.equal(sent, null, "自检不过时不许发请求");
  assert.equal(captures, 0, "自检不过时连参考图都不该渲染");
  preflightOk = true;
}

console.log("image-engine.test.mjs: ok (提交时提示词开头补姿势参考那一句、原句一字不动、"
  + "要英文的卡自动翻一次并把译文发出去、同一句只翻一次、CHP 卡与不需要英文的卡一次都不翻、"
  + "没配好或翻失败都照发不拦、前缀不进作品记录)");
