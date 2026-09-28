/* 中英翻译服务(2026-09-25 用户要求)
 *
 * 责任:把中文角色描述译成英文,并把译文缓存到宿主数据区,同一句话只翻一次。
 * 约束:默认走 CVP 插件自带的翻译接口(`/hamdraw/v1/translate`,与生图共用一套
 *       地址与密码,用户不必另外申请 key)。2026-09-26 用户要求再支持
 *       DeepSeek / Qwen / OpenAI / Claude / Gemini —— 前三家都是 OpenAI 兼容的
 *       `/chat/completions`,所以归成一项;请求组装按 protocol 分派(见文末 PROTOCOLS)。
 *       **除 CVP 外都要用户自己填地址、模型 ID 与 key。**
 *
 * 三件事要说清:
 *
 * 1) **什么时候翻**。生图那一刻(不是打字时、不是保存时)。判据是"当前这张模型卡
 *    标了需要英文"(`needsEnglish === true`)而且提示词里有中文。卡没标就不翻 ——
 *    插件拿到中文自己也能画,凭空多一次往返只会拖慢出图。
 *    生成弹窗里那个「翻译」按钮走的是同一条路(用户主动点,翻完显示在输入框下面)。
 *
 * 2) **翻完存哪**。两级:进程内的 cache(键 = 中文原文),以及作品记录里的
 *    `promptEn { source, text }`。前者是"这句话以后不用再翻",后者是
 *    "这件作品的译文跟着它走" —— 作品列表的编辑界面显示的就是后者,
 *    否则换个作品、换个进程就显示不出已经翻过的英文了。
 *
 * 3) **翻译失败怎么办**。**绝不拦生成**。接口不可达、密码不对、模型没加载,
 *    一律退回原文交给插件(它自己也会译英),只把这件事报给用户看一眼。
 *    这点跟 `enabled` 那个开关是一件事:开关只在"测试翻译"真的成功之后才为真,
 *    没测通就说明这个地址根本不可用,不该拿它去挡用户的出图按钮。
 */
(function (app) {
  "use strict";

  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  var COLLECTION = "posegi", KEY = "prompt-translations", SCHEMA = "posegi-translations/v1", LIMIT = 120;

  var cache = {};
  var loaded = false;

  function t(zh, en) { return app.i18n.text(zh, en); }
  function source(text) { return String(text === null || text === undefined ? "" : text).trim(); }
  function hasCjk(text) { return CJK.test(source(text)); }

  /* 一句话已经翻过就记在 cache 里。加载只做一次:翻译是"本地能查就不用问"的东西,
     每次生图都去读一次数据区,只是白白多一次往返。 */
  async function load() {
    if (loaded) return cache;
    loaded = true;
    var record = null;
    try { record = await app.platform.haminn.getData(COLLECTION, KEY); } catch (error) { return cache; }
    var value = record && record.value;
    if (!value || value.schema !== SCHEMA || !value.entries || typeof value.entries !== "object") return cache;
    Object.keys(value.entries).forEach(function (key) {
      var text = value.entries[key];
      if (key && typeof text === "string" && text) cache[key] = text;
    });
    return cache;
  }

  /* 只留最近 LIMIT 条。key 是中文原文,长度不定,所以按条数而不是字节数限制 ——
     一句角色描述几十个字,120 条也就十几 KB,离宿主单条消息上限差得远。 */
  function persist() {
    var keys = Object.keys(cache), entries = {};
    keys.slice(Math.max(0, keys.length - LIMIT)).forEach(function (key) { entries[key] = cache[key]; });
    try {
      app.platform.haminn.putData(COLLECTION, KEY, { schema: SCHEMA, target: "en", entries: entries });
    } catch (error) { /* 缓存写不进去也还能用,不该因此打断生图 */ }
  }

  /* ---------- 接口格式 ----------
   * 每家只差三件事:请求打到哪个路径、消息怎么装、回复从哪儿取译文。
   * 合成一张表,加一家只改这一处(与 providers 的协议表同一个思路)。
   * 认证头也在这里定:CVP 与 OpenAI 兼容都是 Bearer,Claude 要 x-api-key,
   * Gemini 要 x-goog-api-key —— 用错头只会换来一句语焉不详的 401。 */
  var PROTOCOLS = {
    cvp: {
      zh: "ComfyUI Hamdraw 插件(推荐)", en: "ComfyUI Hamdraw Plugin (recommended)",
      zhHelp: "插件自带翻译大模型,地址与密码就是生图那一套,不用另外申请 key。",
      enHelp: "The plugin ships the translation model; the address and password are the same ones your image cards use.",
      /* 这条只是输入框里的样例(占位符),与模型卡共用同一份出处 */
      endpoint: app.defaults.cvpEndpoint, model: ""
    },
    openai: {
      zh: "OpenAI 兼容(DeepSeek / Qwen / OpenAI)", en: "OpenAI compatible (DeepSeek / Qwen / OpenAI)",
      zhHelp: "任何提供 /v1/chat/completions 的服务都行:DeepSeek、通义千问、OpenAI 或自建网关。",
      enHelp: "Any service exposing /v1/chat/completions: DeepSeek, Qwen, OpenAI or a self-hosted gateway.",
      endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat"
    },
    claude: {
      zh: "Anthropic Claude", en: "Anthropic Claude",
      zhHelp: "走 /v1/messages。地址填 https://api.anthropic.com 即可。",
      enHelp: "Uses /v1/messages. The address is usually https://api.anthropic.com.",
      endpoint: "https://api.anthropic.com", model: "claude-3-5-haiku-latest"
    },
    gemini: {
      zh: "Google Gemini", en: "Google Gemini",
      zhHelp: "走 /v1beta/models/<模型>:generateContent。",
      enHelp: "Uses /v1beta/models/<model>:generateContent.",
      endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash"
    }
  };

  var SYSTEM_PROMPT = "Translate the user's text into English. Reply with the translation only — " +
    "no quotes, no notes, no alternatives.";

  function protocolOf(value) {
    var id = String(value && value.protocol || "cvp");
    return Object.prototype.hasOwnProperty.call(PROTOCOLS, id) ? id : "cvp";
  }

  function stripSlash(value) { return String(value || "").replace(/\/+$/, ""); }

  /* 用户可能填到域名,也可能填到 /v1 —— 两种都认,别把版本号拼两遍 */
  function versionedRoot(value, version) {
    var root = stripSlash(value);
    return new RegExp("/" + version + "$").test(root) ? root : root + "/" + version;
  }

  /* 译英服务跟着 CVP 连接走。单独在设置里填了 endpoint 就以那份为准(比如翻译跑在
     另一台机器上,或者干脆用云端模型);没填就借生图用的那套地址与密码 ——
     那条路一定是 CVP,因为只有 cvp 卡共用一份 connection。 */
  function connection() {
    var own = app.config && app.config.translate;
    if (own && source(own.endpoint)) {
      return {
        protocol: protocolOf(own), endpoint: source(own.endpoint),
        apiKey: String(own.apiKey || ""), model: String(own.model || ""),
        customHeaders: String(own.customHeaders || "")
      };
    }
    var shared = app.config && app.config.connection;
    if (shared && source(shared.endpoint)) {
      return {
        protocol: "cvp", endpoint: source(shared.endpoint),
        apiKey: String(shared.apiKey || ""), model: "",
        customHeaders: String(shared.customHeaders || "")
      };
    }
    return null;
  }

  /* 一句中文 → 一个可以直接发的请求。**批量由我们自己循环**,不赌模型会老老实实
     回一个 JSON 数组 —— 它回错了还得猜着解析,失败面比多几次往返大得多。 */
  function buildRequest(protocol, item, prompts) {
    var prompt = prompts[0];
    var output = app.utils.parseHeaders(item.customHeaders || "");
    output["Content-Type"] = "application/json";
    if (item.apiKey && !output.Authorization && !output.authorization) {
      output.Authorization = "Bearer " + item.apiKey;
    }
    if (protocol === "cvp") {
      return {
        url: app.services.providers.internals.cvpBase(item.endpoint) + "/hamdraw/v1/translate",
        headers: output,
        bodyText: JSON.stringify({ texts: prompts, target: "en" })
      };
    }
    if (protocol === "openai") {
      return {
        url: versionedRoot(item.endpoint, "v1") + "/chat/completions",
        headers: output,
        bodyText: JSON.stringify({
          model: item.model, temperature: 0,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }]
        })
      };
    }
    if (protocol === "claude") {
      delete output.Authorization;
      if (item.apiKey && !output["x-api-key"]) output["x-api-key"] = item.apiKey;
      if (!output["anthropic-version"]) output["anthropic-version"] = "2023-06-01";
      return {
        url: versionedRoot(item.endpoint, "v1") + "/messages",
        headers: output,
        bodyText: JSON.stringify({
          model: item.model, max_tokens: 1024, temperature: 0,
          system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }]
        })
      };
    }
    delete output.Authorization;
    if (item.apiKey && !output["x-goog-api-key"]) output["x-goog-api-key"] = item.apiKey;
    return {
      url: versionedRoot(item.endpoint, "v1beta") + "/models/" + encodeURIComponent(item.model) + ":generateContent",
      headers: output,
      bodyText: JSON.stringify({ contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }] })
    };
  }

  /* 各家把译文塞在不同地方,取法归这里 */
  function extract(protocol, payload, position) {
    var index = Number(position) || 0;
    if (!payload) return "";
    if (protocol === "cvp") {
      var entry = payload.results && payload.results[index];
      return entry && entry.translated ? source(entry.text) : "";
    }
    if (protocol === "openai") {
      var choice = payload.choices && payload.choices[0];
      return source(choice && choice.message && choice.message.content);
    }
    if (protocol === "claude") {
      var block = payload.content && payload.content[0];
      return source(block && block.text);
    }
    var candidate = payload.candidates && payload.candidates[0];
    var part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    return source(part && part.text);
  }

  /* 云端模型爱加戏:包一层代码块、来一句「Translation:」、把整句塞进引号。
     这些都不是译文的一部分,留着会直接进生图提示词。 */
  function cleanup(value) {
    var text = source(value).replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
    text = text.replace(/^(translation|english|译文|英文|译成英文)\s*[:：]\s*/i, "").trim();
    if (text.length > 1 && /^["'“”‘’].*["'“”‘’]$/.test(text)) text = text.slice(1, -1).trim();
    return text;
  }

  /* 返回 null 表示"请求根本没出去"(以此区别于"翻不了" —— 那是 translated:false)。
     插件接口一次能收多段(它按发送顺序回 N 条),所以批量发;别家逐句 ——
     让云端模型自己吐一个 JSON 数组,回错了还得猜着解析,失败面更大。 */
  async function ask(item, texts) {
    var protocol = protocolOf(item);
    var groups = protocol === "cvp" ? [texts] : texts.map(function (one) { return [one]; });
    var results = [];
    for (var index = 0; index < groups.length; index += 1) {
      var group = groups[index];
      var request = buildRequest(protocol, item, group);
      var response;
      try {
        response = await app.platform.haminn.request({
          url: request.url, method: "POST", headers: request.headers,
          bodyText: request.bodyText, timeoutMs: 40000
        });
      } catch (error) { return null; }
      if (!(response.status >= 200 && response.status < 300)) return null;
      var payload = app.utils.parseJson(response.bodyText || "", null);
      group.forEach(function (prompt, position) {
        var text = cleanup(extract(protocol, payload, position));
        /* 回来的还是中文(或空)就不算译文 —— 宁可按原文发,也别把中文当英文塞回去。
           CVP 自己给 translated 标志,别家没有,所以统一按"译文里不该有汉字"判。 */
        var usable = Boolean(text) && !hasCjk(text);
        if (usable) cache[prompt] = text;
        results.push({ text: usable ? text : prompt, translated: usable });
      });
    }
    return results;
  }

  /* 提交给模型的提示词:英文原样透传(绝不改写用户写的英文),
     中文只有在缓存里有译文时才替换 —— 没有就走原文,交给插件。 */
  function english(text) {
    var key = source(text);
    if (!key || !hasCjk(key)) return key;
    return cache[key] || key;
  }

  function translated(text) { var key = source(text); return Boolean(key && cache[key]); }

  /* 作品里存的那对译文与它的原文。原文改了这对就作废 ——
     否则用户把「一个科幻女战士」改成「一个古代剑客」,编辑界面还显示着
     "a sci-fi female warrior"。 */
  function pair(prompt, englishText) {
    var key = source(prompt);
    if (!key) return null;
    var text = source(englishText) || cache[key] || "";
    if (!text || !hasCjk(key)) return null;
    return { source: key, text: text };
  }

  function fromPair(work, prompt) {
    var key = source(prompt);
    var stored = work && work.promptEn;
    if (stored && source(stored.source) === key && source(stored.text)) return source(stored.text);
    return cache[key] ? cache[key] : "";
  }

  /* 只翻"还没翻过"的。返回真正请求出去的结果,空数组 = 没有要翻的。 */
  async function translate(texts) {
    await load();
    var wanted = [], seen = {};
    (texts || []).map(source).forEach(function (value) {
      if (value && hasCjk(value) && !cache[value] && !seen[value]) { seen[value] = true; wanted.push(value); }
    });
    if (!wanted.length) return [];
    var item = connection();
    if (!item) return [];
    var results = await ask(item, wanted);
    persist();
    return results || [];
  }

  /* ---------- 设置里的「添加中英文翻译模型」 ---------- */

  var PROBE_TEXT = "一只蓝色的水晶鸟";

  /* 翻译这件事只有两个状态:能翻、不能翻。探测必须看到"中文进去、英文出来"才算成功,
     否则设置界面就只能让用户去猜为什么每张图都发中文。 */
  async function probe(config) {
    var protocol = protocolOf(config);
    var item = {
      protocol: protocol,
      endpoint: source(config && config.endpoint),
      apiKey: String(config && config.apiKey || ""),
      model: String(config && config.model || ""),
      customHeaders: String(config && config.customHeaders || "")
    };
    if (!item.endpoint) throw new Error(t("请先填写翻译服务地址", "Enter the translation endpoint first"));
    if (protocol !== "cvp" && !item.model) throw new Error(t("请填写模型 ID", "Enter the model id"));
    var request = buildRequest(protocol, item, [PROBE_TEXT]);
    var response = await app.platform.haminn.request({
      url: request.url, method: "POST", headers: request.headers,
      bodyText: request.bodyText, timeoutMs: 40000
    });
    if (!(response.status >= 200 && response.status < 300)) throw new Error("HTTP " + response.status);
    var payload = app.utils.parseJson(response.bodyText || "", null);
    var text = cleanup(extract(protocol, payload, 0));
    if (!text || hasCjk(text)) {
      throw new Error(t("接口有响应但没有译文:请确认地址、模型 ID 与密钥都填对了",
        "The endpoint answered but returned no translation. Check the address, the model id and the key."));
    }
    cache[PROBE_TEXT] = text;
    persist();
    /* 报给界面看的"实际用了哪个模型":插件会自报 engine,别家就是我们填的模型 ID */
    var engine = protocol === "cvp" ? source(payload && payload.engine) : source(item.model);
    return { engine: engine, example: PROBE_TEXT, text: text };
  }

  /* 生图时到底翻不翻:卡标了要英文,而且译英服务测通过。 */
  function needed(model) { return Boolean(model && model.needsEnglish === true); }
  function ready() { return Boolean(app.config && app.config.translate && app.config.translate.enabled) && Boolean(connection()); }

  app.services.translate = {
    protocols: PROTOCOLS,
    load: load,
    hasCjk: hasCjk,
    english: english,
    translated: translated,
    translate: translate,
    pair: pair,
    fromPair: fromPair,
    probe: probe,
    needed: needed,
    ready: ready,
    internals: { cache: cache, connection: connection, buildRequest: buildRequest, persist: persist, ask: ask }
  };
})(window.posegi);
