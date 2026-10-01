/* 中英翻译 + 作品(最近使用 / 新建 / 编辑)的测试
 *
 * 这里锁的都是"看起来在工作、其实没生效"型的问题:
 *   - 提示词里有中文却没翻(或者反过来:全英文也被送去翻一遍);
 *   - 卡片上的「需要翻译为英文」开关因为写成了真值判断,旧卡被凭空当成需要翻译;
 *   - 改了角色描述,作品里还挂着上一句话的英文译文(下一提交就发那句旧的);
 *   - 编辑作品时只传标题就被当成"把描述清空了"。
 * 这些都不会报错,只会在几天后变成"为什么模型收到的还是中文"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/providers.js", "app/services/render-adjust.js", "app/services/store.js", "app/services/translate.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const store = app.services.store;
const translate = app.services.translate;
const cache = translate.internals.cache;

/* 宿主替身:数据区放内存,网络只认插件的翻译端点。
   翻译端点的行为照实写 —— 它**从不返回错误**:中文回译文 + translated:true,
   英文回原文 + translated:false。 */
const mem = new Map();
const calls = [];
const CJK = /[\u4e00-\u9fff]/;
/* 替身译文的形状要和真的一致:纯 ASCII、不带汉字。带汉字的"译文"会被
   probe 的"译文必须不含中文"判定打回(现实中那种回复不是译文)。 */
const fakeEnglish = (text) => "en<" + text.length + "-" + text.charCodeAt(0).toString(16) + ">";
let probeReply = null;

app.platform.haminn = {
  getData: async (collection, key) => {
    const name = collection + "/" + key;
    return mem.has(name) ? { collection, key, value: mem.get(name) } : null;
  },
  putData: async (collection, key, value) => { mem.set(collection + "/" + key, value); return { collection, key, value }; },
  deleteData: async (collection, key) => { mem.delete(collection + "/" + key); return { deleted: true }; },
  request: async (options) => {
    calls.push(options.url);
    if (probeReply) return probeReply;
    const body = JSON.parse(options.bodyText || "{}");
    const results = (body.texts || []).map((text) => CJK.test(text)
      ? { text: fakeEnglish(text), translated: true }
      : { text, translated: false });
    return { status: 200, bodyText: JSON.stringify({ engine: "fake-translator", results }) };
  },
  saveImage: async () => ({ exported: true })
};

/* ---------- 1) 中文字符判定 ---------- */
{
  assert.equal(translate.hasCjk("一个科幻女战士"), true);
  assert.equal(translate.hasCjk("a sci-fi warrior"), false);
  assert.equal(translate.hasCjk("girl 女孩"), true, "中英混排必须算中文");
  assert.equal(translate.hasCjk(""), false);
  assert.equal(translate.hasCjk(null), false);
  assert.equal(translate.hasCjk("ＡＢＣ1234！"), false, "全角标点不是汉字,不该触发翻译");
  assert.equal(translate.hasCjk("カタカナ"), true, "日文假名一并算进 CJK 区间");
}

/* ---------- 2) english():英文原样透传,中文只在有译文时替换 ---------- */
{
  assert.equal(translate.english("  a sci-fi warrior  "), "a sci-fi warrior");
  assert.equal(translate.english("一个科幻女战士"), "一个科幻女战士", "还没翻过的中文只能回原文,绝不能变成空");
  assert.equal(translate.english(""), "");
}

/* ---------- 3) translate():只翻没翻过的中文,英文不占网络 ---------- */
{
  await store.loadConfig();
  app.config.connection.endpoint = "http://192.168.124.31:8189/chp/";
  app.config.translate = { enabled: true, endpoint: "", apiKey: "", customHeaders: "" };

  /* 默认没配好(enabled=false)时不该翻 */
  app.config.translate.enabled = false;
  assert.equal(translate.ready(), false, "没测试通过(enabled=false)就不算就绪");
  app.config.translate.enabled = true;
  assert.equal(translate.ready(), true);

  const before = calls.length;
  const empty = await translate.translate(["a sci-fi warrior", "", "  "]);
  assert.deepEqual(empty, [], "一句中文都没有时不该发请求");
  assert.equal(calls.length, before, "全英文不该产生网络往返");

  const asked = await translate.translate(["一个科幻女战士", "一个科幻女战士", "一座雪山"]);
  assert.equal(calls.length, before + 1, "两条不重复的中文合并成一次请求");
  assert.equal(asked.length, 2, "重复的那条只发一次");
  assert.equal(calls[calls.length - 1], "http://192.168.124.31:8189/chp/translate",
    "地址要去掉重复的 /chp/ 再拼端点");

  assert.equal(translate.translated("一个科幻女战士"), true);
  assert.equal(translate.english("一个科幻女战士"), fakeEnglish("一个科幻女战士"));

  /* 第二遍:缓存命中,不再发请求 */
  const again = calls.length;
  await translate.translate(["一个科幻女战士"]);
  assert.equal(calls.length, again, "同一句话只翻一次");

  /* 缓存要落进数据区:换了进程还得有 */
  const record = mem.get("posegi/prompt-translations");
  assert.ok(record, "译文必须写进数据区");
  assert.equal(record.schema, "posegi-translations/v1");
  assert.equal(record.target, "en");
  assert.equal(record.entries["一个科幻女战士"], fakeEnglish("一个科幻女战士"));
  assert.equal(record.entries["a sci-fi warrior"], undefined, "英文不该进缓存");
}

/* ---------- 4) 译文与原文成对:原文一改,译文立刻作废 ---------- */
{
  const pair = translate.pair("一座雪山", "");
  assert.deepEqual(pair, { source: "一座雪山", text: fakeEnglish("一座雪山") }, "缓存里有就直接拿来配对");
  assert.equal(translate.pair("a snowy mountain", ""), null, "英文没有译文对");
  assert.equal(translate.pair("", ""), null);

  const work = { promptEn: { source: "一座雪山", text: fakeEnglish("一座雪山") } };
  assert.equal(translate.fromPair(work, "一座雪山"), fakeEnglish("一座雪山"));
  assert.equal(translate.fromPair(work, "一片森林"), "", "描述换了,旧译文不能再显示");
  assert.equal(translate.fromPair(work, " 一座雪山 "), fakeEnglish("一座雪山"), "两边的空白不影响配对");
}

/* ---------- 5) 探针:只有"中文进去、英文出来"才算通过 ---------- */
{
  const ok = await translate.probe({ endpoint: "http://192.168.124.31:8189", apiKey: "", customHeaders: "" });
  assert.equal(ok.text, fakeEnglish("一只蓝色的水晶鸟"));
  assert.equal(ok.engine, "fake-translator");

  /* 接口有响应但没译文(插件没加载翻译模型)→ 必须报错,而不是当成"能翻" */
  probeReply = { status: 200, bodyText: JSON.stringify({ engine: "", results: [{ text: "一只蓝色的水晶鸟", translated: false }] }) };
  await assert.rejects(() => translate.probe({ endpoint: "http://192.168.124.31:8189" }));
  probeReply = { status: 500, bodyText: "boom" };
  await assert.rejects(() => translate.probe({ endpoint: "http://192.168.124.31:8189" }));
  probeReply = null;
  await assert.rejects(() => translate.probe({ endpoint: "" }), /地址/, "空地址在发请求之前就该被拦住");

  /* 单独填了翻译地址时以它为准(翻译可以跑在另一台机器上) */
  app.config.translate.endpoint = "http://192.168.124.9:8189";
  assert.equal(translate.internals.connection().endpoint, "http://192.168.124.9:8189");
  app.config.translate.endpoint = "";
  assert.equal(translate.internals.connection().endpoint, app.config.connection.endpoint, "没单独填就借生图那一套");
}

/* ---------- 6) 模型卡的译英开关:必须是严格的 true ---------- */
{
  /* 走 shapeConfig 而不是直接调 shapeModel:shapeModel 是私有的,
     而"配置存下去再读回来"这条路上真正会被执行的就是它。 */
  const shape = (item) => store.shapeConfig({ schema: 4, models: [item] }).models[0];
  assert.equal(shape({ id: "a", needsEnglish: true }).needsEnglish, true);
  assert.equal(shape({ id: "a", needsEnglish: false }).needsEnglish, false);
  /* 旧版本存下来的卡没有这个字段 —— 真值判断会把 undefined 当成"需要翻译",
     给老用户凭空多一次网络往返。 */
  assert.equal(shape({ id: "a" }).needsEnglish, false);
  assert.equal(shape({ id: "a", needsEnglish: 1 }).needsEnglish, false);
  assert.equal(shape({ id: "a", needsEnglish: "true" }).needsEnglish, false);
  assert.equal(translate.needed({ protocol: "openai", needsEnglish: true }), true,
    "非 CHP 的卡标了要英文 ⇒ 提交时该替它翻一次");
  assert.equal(translate.needed({ protocol: "chp", needsEnglish: true }), false,
    "CHP 卡一律不翻(用户定:「CHP 内部可以对模型的工作流添加翻译节点,就是说 CHP 提供的模型"
    + "都可以视为不需要中文翻译英文」)—— 它的 translation.mode 本来就是 auto-on-submit");
  assert.equal(translate.needed({ needsEnglish: true }), false,
    "协议字段缺失按 CHP 处理 ⇒ 同样不翻(客户端译英的后端本来就是那个插件)");
  assert.equal(translate.needed({ protocol: "openai", needsEnglish: false }), false);
  assert.equal(translate.needed({}), false);
  assert.equal(translate.needed(null), false);

  /* 出厂卡一律不吃翻译:插件自己会译英,默认不该多一次往返 */
  app.defaults.models.forEach((item) => assert.equal(item.needsEnglish, false, item.id + " 出厂不该打开翻译"));
  /* 新建卡(切协议 / 切任务)也必须带上这个字段,否则整份 draft 被覆盖时会丢 */
  assert.equal(app.services.providers.preset("chp", "render").needsEnglish, false);
}

/* ---------- 6b) relevant():界面中文 + 当前这张卡标了需要英文 + 它不是 CHP ----------
    2026-09-30 用户定:「如果当前激活的生图模型不需要英文翻译,那么中文情况下也要
    去掉所有翻译相关的机制和UI,调用时候直接用默认输入就可以不用管中英文了」,
    以及「CHP 提供的模型都可以视为不需要中文翻译英文」。
    界面的提示(translate-hint 的 labelHint)、"该不该自动翻"(image-engine 的 prepare)、
    设置里那一整块(settings 的 wantsTranslate)问的都是这一句 ——
    它一旦放宽,那句「请使用英文」会在不该出现的地方冒出来,而三处不会同时错。 */
{
  const real = app.services.providers;
  const realLanguage = app.i18n.language;
  let lang = "zh";
  let active = { id: "card", protocol: "openai", needsEnglish: true };
  app.services.providers = { active: () => active };
  /* 这一组不装真 document(setLanguage 会去写 documentElement),而这里要的只是
     "界面语言是哪一种"这一个答案 —— 直接把它钉住更省事,也不会牵进无关依赖。 */
  app.i18n.language = () => lang;

  assert.equal(translate.relevant(), true, "中文界面 + 非 CHP 的卡要英文 ⇒ 这套机制在用");

  active = { id: "chp-qwen", protocol: "chp", needsEnglish: true };
  assert.equal(translate.relevant(), false,
    "CHP 卡 ⇒ 整套翻译机制都该消失(插件自己在工作流里译,客户端不必插手)");

  active = { id: "card", protocol: "openai", needsEnglish: false };
  assert.equal(translate.relevant(), false, "卡不要英文 ⇒ 整套翻译机制都该消失");

  active = { id: "card", protocol: "openai" };
  assert.equal(translate.relevant(), false, "字段缺失按「不需要英文」处理,不许当成要翻");

  active = null;
  assert.equal(translate.relevant(), false, "一张卡都没有时也不该冒出那句提示");

  active = { id: "card", protocol: "openai", needsEnglish: true };
  lang = "en";
  assert.equal(translate.relevant(), false, "英文界面下这套机制本来就不存在");

  app.i18n.language = realLanguage;
  app.services.providers = real;
}

/* ---------- 7) 补卡迁移只属于 schema 3 那一次 ---------- */
{
  const custom = [{ id: "mine", name: "我的卡", protocol: "chp", task: "fast" }];
  const old = store.shapeConfig({ schema: 2, models: custom });
  assert.equal(old.models.length, 1 + app.defaults.models.length, "schema 2 的旧装机要补回出厂卡");
  const fresh = store.shapeConfig({ schema: 4, models: custom });
  assert.deepEqual(fresh.models.map((item) => item.id), ["mine"],
    "已经是 schema 4 的配置不该再把用户删掉的出厂卡塞回来");
  assert.equal(fresh.schema, app.defaults.schema);
  assert.equal(store.shapeConfig({}).preferences.lastWorkId, "", "lastWorkId 要有默认值");
  assert.equal(store.shapeConfig({}).translate.enabled, false, "翻译默认关闭");
}

/* ---------- 8) 新建作品:默认描述 + 未命名序号 + 记下"最近使用" ---------- */
{
  assert.equal(store.defaultPrompt(), app.defaults.newWork.prompt.zh, "用户定的默认角色描述");
  assert.equal(app.defaults.newWork.prompt.zh, "一个正在跳舞的中国美女，健康体型，平视。",
    "新建作品默认中文描述要使用用户指定的舞蹈人物场景");
  assert.equal(app.defaults.newWork.prompt.en,
    "A beautiful Chinese woman dancing, with a healthy physique, viewed at eye level.",
    "英文界面要使用对应的默认描述");
  assert.equal(store.untitledTitle(), "未命名作品1");

  await store.newWork("");
  assert.equal(app.state.workTitle, "未命名作品1");
  assert.equal(app.state.prompt, app.defaults.newWork.prompt.zh, "新建作品要带上默认描述");
  assert.equal(store.hasWorks(), true);
  assert.equal(store.lastWorkId(), app.state.workId, "新建的作品就是最近使用的那一件");
  assert.equal(store.untitledTitle(), "未命名作品2", "序号要接着已有的往下数");

  /* 描述显式传空串 = 用户清空了它,照样允许 */
  await store.newWork("空白作品", "");
  assert.equal(app.state.prompt, "");
  assert.equal(app.state.workTitle, "空白作品");
}

/* ---------- 9) 编辑作品:没传 description 不能当成"清空" ---------- */
{
  app.state.workId = "work-a";
  app.state.workTitle = "甲";
  app.state.prompt = "一个科幻女战士";
  app.state.promptEn = null;
  app.state.results = [];

  await store.updateWork("work-a", { title: "甲改名" });
  assert.equal(app.state.workTitle, "甲改名");
  assert.equal(app.state.prompt, "一个科幻女战士", "只改标题不该把描述抹掉");

  await store.updateWork("work-a", { title: "甲改名", prompt: "" });
  assert.equal(app.state.prompt, "", "显式传空串就该清空");

  await store.updateWork("work-a", { title: "甲改名", prompt: "一座雪山" });
  assert.deepEqual(app.state.promptEn, { source: "一座雪山", text: fakeEnglish("一座雪山") },
    "改描述时缓存里正好有译文就顺手挂上");
  const saved = mem.get("work/work-a");
  assert.deepEqual(saved.promptEn, { source: "一座雪山", text: fakeEnglish("一座雪山") });

  /* 描述改成缓存里没有的一句 → 旧译文必须作废,不能留在记录里 */
  await store.updateWork("work-a", { title: "甲改名", prompt: "一片没有翻译过的森林" });
  assert.equal(app.state.promptEn, null);
  assert.equal(mem.get("work/work-a").promptEn, null);
}

/* ---------- 10) 译文跟着作品落盘,也出现在列表里 ---------- */
{
  const list = store.listWorks();
  const entry = list.filter((item) => item.id === "work-a")[0];
  assert.ok(entry, "作品应该出现在列表索引里");
  assert.equal(entry.title, "甲改名");
  assert.equal(entry.prompt, "一片没有翻译过的森林");
  assert.equal(entry.promptEn, null);
}

/* ---------- 11) 多家翻译接口:请求怎么拼(2026-09-26 用户要求) ---------- */
{
  const build = translate.internals.buildRequest;

  /* CHP:插件接口一次能收多段,认证走 Bearer */
  const chp = build("chp", { endpoint: "http://192.168.124.31:8189/chp", apiKey: "pw", customHeaders: "" }, ["甲", "乙"]);
  assert.equal(chp.url, "http://192.168.124.31:8189/chp/translate");
  assert.equal(chp.headers.Authorization, "Bearer pw");
  assert.deepEqual(JSON.parse(chp.bodyText), { texts: ["甲", "乙"], target: "en" });

  /* OpenAI 兼容(DeepSeek / Qwen / OpenAI):/chat/completions */
  const openai = build("openai", { endpoint: "https://api.deepseek.com", apiKey: "sk-x", model: "deepseek-chat", customHeaders: "" }, ["甲"]);
  assert.equal(openai.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer sk-x");
  assert.equal(JSON.parse(openai.bodyText).model, "deepseek-chat");

  /* 地址本来就写到 /v1 的,不能再拼一遍 */
  const deep = build("openai", { endpoint: "https://api.openai.com/v1/", apiKey: "k", model: "gpt-4o-mini", customHeaders: "" }, ["甲"]);
  assert.equal(deep.url, "https://api.openai.com/v1/chat/completions");

  /* Claude 认 x-api-key,不认 Bearer —— 用错头只会换来一句语焉不详的 401 */
  const claude = build("claude", { endpoint: "https://api.anthropic.com", apiKey: "sk-ant", model: "claude-3-5-haiku-latest", customHeaders: "" }, ["甲"]);
  assert.equal(claude.url, "https://api.anthropic.com/v1/messages");
  assert.equal(claude.headers["x-api-key"], "sk-ant");
  assert.equal(claude.headers["anthropic-version"], "2023-06-01");
  assert.equal(claude.headers.Authorization, undefined, "Claude 不该收到 Bearer");

  /* Gemini 把模型名放在路径里,认证头是 x-goog-api-key */
  const gemini = build("gemini", { endpoint: "https://generativelanguage.googleapis.com", apiKey: "g-key", model: "gemini-2.0-flash", customHeaders: "" }, ["甲"]);
  assert.equal(gemini.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(gemini.headers["x-goog-api-key"], "g-key");
  assert.equal(gemini.headers.Authorization, undefined, "Gemini 不该收到 Bearer");

  /* 用户自己写的请求头优先于我们拼的认证头 */
  const custom = build("openai", { endpoint: "https://x.test/v1", apiKey: "k", model: "m", customHeaders: '{"Authorization":"Bearer custom"}' }, ["甲"]);
  assert.equal(custom.headers.Authorization, "Bearer custom");
}

/* ---------- 12) 协议白名单:不认识的必须落回 chp ---------- */
{
  const kept = store.shapeConfig({ schema: 4, translate: { protocol: "openai", endpoint: "https://x", apiKey: "k", model: "m" } });
  assert.equal(kept.translate.protocol, "openai");
  assert.equal(kept.translate.model, "m");
  const bogus = store.shapeConfig({ schema: 4, translate: { protocol: "some-llm", endpoint: "https://x" } });
  assert.equal(bogus.translate.protocol, "chp", "不认识的协议要落回 CHP,否则地址会按错格式拼");
  /* 改名前的装机:盘上写的是 cvp。它落在白名单外 —— 回落到 chp,也就是**同一个协议**。
     这条不加迁移的历史原因:PoseGi 的协议白名单下落点本来就是 chp,不像 hamdraw
     那样把 cvp 当成一个合法选项(那边必须写一次 schema 迁移)。 */
  const renamed = store.shapeConfig({ schema: 4, translate: { protocol: "cvp", enabled: true, endpoint: "http://10.0.0.8:8189/chp", model: "old" } });
  assert.equal(renamed.translate.protocol, "chp", "改名前的 cvp 要落回 CHP 而不是别家");
  assert.equal(renamed.translate.enabled, true, "别的字段一律不动");
  assert.equal(renamed.translate.endpoint, "http://10.0.0.8:8189/chp");
  assert.equal(renamed.translate.model, "old");
}

/* ---------- 13) 各家回复里怎么把译文取出来(走 probe,那才是真发请求的那条路) ---------- */
{
  const replies = [
    { protocol: "openai", endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat",
      reply: { choices: [{ message: { content: "a blue crystal bird" } }] } },
    { protocol: "claude", endpoint: "https://api.anthropic.com", model: "claude-3-5-haiku-latest",
      reply: { content: [{ type: "text", text: "a blue crystal bird" }] } },
    { protocol: "gemini", endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash",
      reply: { candidates: [{ content: { parts: [{ text: "a blue crystal bird" }] } }] } }
  ];
  for (const item of replies) {
    probeReply = { status: 200, bodyText: JSON.stringify(item.reply) };
    const result = await translate.probe({ protocol: item.protocol, endpoint: item.endpoint, apiKey: "k", model: item.model });
    assert.equal(result.text, "a blue crystal bird", item.protocol + " 的译文应该能取出来");
    assert.equal(result.engine, item.model);
  }

  /* 云端模型爱加戏:包一层代码块、加个 "English:" 前缀、把整句塞进引号 —— 都要洗掉 */
  probeReply = { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: "```\nEnglish: \"a blue crystal bird\"\n```" } }] }) };
  const cleaned = await translate.probe({ protocol: "openai", endpoint: "https://x.test/v1", apiKey: "k", model: "m" });
  assert.equal(cleaned.text, "a blue crystal bird");

  /* 回来的还是中文 → 不算译文,必须报错(不然会把中文当英文发去生图) */
  probeReply = { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: "一只蓝色的水晶鸟" } }] }) };
  await assert.rejects(() => translate.probe({ protocol: "openai", endpoint: "https://x.test/v1", apiKey: "k", model: "m" }));

  /* 非 CHP 没填模型 ID 直接拦下,不发请求 */
  probeReply = null;
  await assert.rejects(() => translate.probe({ protocol: "gemini", endpoint: "https://g.test", apiKey: "k", model: "" }));
}

console.log("translate.test.mjs: ok");
