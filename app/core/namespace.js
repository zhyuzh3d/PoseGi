/* PoseGi 命名空间与全局状态
 *
 * 责任:建立 window.posegi,定义事件总线、运行时状态与默认配置的形状。
 * 约束:只放数据结构与全局单例,不含任何业务逻辑;core 层不碰 DOM。
 */
(function (global) {
  "use strict";

  var app = global.posegi = global.posegi || {};
  var listeners = {};

  /* 与 hermit.json 的 version.name 必须一致(tests/rig.test.mjs 守着)。
     上一轮发版只改了 hermit.json(code 3 / 0.1.1),这里漏了 —— 于是界面上
     顶着「v0.1.0」而装上去的包里写着 0.1.1。以 hermit.json 为准,这里跟上。 */
  app.version = "0.1.1";

  /* 主题锁:本应用不做主题切换(设置里没有这一项),一律深色。
     2026-09-25 用户决定 —— 之前跟着系统 prefers-color-scheme 走,新设备系统非深色
     就落到亮色,环境球也跟着变亮,与"深色场景"的产品定位不符。唯一出处在这里。 */
  app.THEME = "dark";

  app.events = {
    on: function (name, listener) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (item) { return item !== listener; });
      };
    },
    emit: function (name, detail) {
      (listeners[name] || []).slice().forEach(function (listener) {
        try { listener(detail); } catch (error) { setTimeout(function () { throw error; }, 0); }
      });
    }
  };

  /* 运行时状态:一屏之内的即时值,不直接落盘。
   *
   * 作品的边界(2026-09-25 用户定的形态,参照 vibedraw):
   *   「作品」= 标题 + 提示词 + 属于它的历史成图(最多 12 张)。
   *   成图挂在作品下面,所以"历史成图跟随作品保存"是数据形状本身保证的,
   *   不是靠某个保存时机去补救。换作品 = 换一组成图。 */
  app.state = {
    theme: app.THEME,
    selectedJoint: "",
    selectedPart: "bone",
    poseName: "",
    dirty: false,
    view: { azimuth: 0, elevation: 0, distance: 3.2, targetY: 0.95 },
    busy: false,
    status: "",
    /* 当前作品 */
    workId: "",
    workTitle: "",
    prompt: "",
    /* 角色描述的英文译文,形状是 { source, text }:source 是当时的原文。
       存成一对是因为"原文改了译文就作废"这件事必须能判出来 ——
       只存一句英文的话,用户把描述改成另一句话,界面上还挂着旧译文。 */
    promptEn: null,
    negativePrompt: "",
    results: [],
    /* 生图用哪张模型卡 —— 模型设置里点一下激活的那张,唯一出处 */
    activeModelId: "",
    history: [],
    future: []
  };

  /* 持久化配置:形状固定,字段含义见 README 与各 services 模块。 */
  app.defaults = {
    /* schema 3 → 4:模型卡多了 `needsEnglish`(需要翻译为英文的开关),
       配置多了 `translate`(译英服务)与 `preferences.lastWorkId`(上次打开的作品)。
       前两项由 store.shapeModel / shapeConfig 补默认值,第三项只是个空串 ——
       所以这次迁移没有"补卡"这类结构动作,只用来标记版本。 */
    schema: 4,
    preferences: { theme: app.THEME, language: "system", lastWorkId: "" },
    /* 译英服务(2026-09-25 用户要求):只对"标记为需要英文"的生图模型生效。
       默认跟着 CVP 的连接走 —— 插件自带翻译大模型,地址与密码就是那一套;
       单独填了 endpoint 就以这份为准。enabled 只在"测试翻译成功"之后才为真,
       没测通就绝不拿它去拦生成(见 services/translate.js)。
       protocol 的取值见 translate.protocols:cvp / openai(DeepSeek、Qwen 都是这个
       格式)/ claude / gemini(2026-09-26 用户要求支持这几家)。
       借生图连接那条路一定是 cvp —— 生图只有 CVP 卡片共用一套地址。 */
    translate: { enabled: false, protocol: "cvp", endpoint: "", apiKey: "", model: "", customHeaders: "" },
    /* 新建作品时的默认角色描述(用户 2026-09-25 定:默认「一个科幻女战士」)。
       中文界面给中文、英文界面给英文 —— 它是提示词内容,不是界面文案,
       所以要跟着界面语言走。放在这里是因为"添加作品"表单与首次启动那次弹窗共用一份。
       2026-09-26 用户要求再自带一句:**参考图只作姿势参考**。参考图是 3D 小人的渲染,
       模型只该拿它的姿势与构图,不该把那个"木头小人"的外形、发型、服饰也画出来。
       把它写进默认描述而不是在请求里偷偷追加:它就在输入框里,用户看得见、改得掉。
       改这句只动这一处 —— "添加作品"表单与 newWork 都读它。 */
    newWork: {
      prompt: {
        zh: "一个科幻女战士。参考图只作姿势参考,不要照抄它的人物外形,发型和服饰。",
        en: "a sci-fi female warrior. Use the reference image for pose only. Do not copy its figure's look, hairstyle or clothing."
      }
    },
    /* CVP(ComfyUI VibeDraw Plugin)的连接是**一套**:地址、密码、自定义头。
       填一次,所有 protocol 为 cvp 的模型卡一起生效 —— 插件本来就是一个进程,
       每张卡各填一份地址只会让人重复劳动,还会出现"两张卡填了不同地址"的鬼状态。
       非 CVP 的卡(OpenAI Images / SD WebUI / Stability)各有各的 endpoint。 */
    connection: { endpoint: "", apiKey: "", customHeaders: "" },
    /* 还没填过 CVP 地址时,「服务器地址」里预填的那条样例 —— 只有 IP 是要改的地方,
       所以它本身不是一个能直接用的地址,是给用户照着改的。
       (2026-09-26 用户要求:**已经填过就绝不去动它**,只在配置里还没有地址时才填这一条。) */
    cvpEndpoint: "http://192.168.1.31:8189/vibedraw",
    /* CVP 每个任务的出厂参数:**这一份是唯一出处**,界面、store 的字段夹取、
       providers 的请求组装都读它。以前"画幅范围 / 步数 / 参考图基准"散在 providers
       的三处 if 里,加一张卡要同时改三个地方,忘一处就是"新卡按老卡的画幅发请求"。
       size 写 [最小, 最大, 步进],与插件 capabilities 里列出的可选画幅一致:
       插件只认它自己报出来的那几档,发出别的值会被 400 顶回来。 */
    cvpTasks: {
      quick: { size: [512, 512, 512], steps: 8, refBase: 0.55, timeoutMs: 60000 },
      upscale: { size: [1024, 1024, 512], steps: 8, refBase: 0.75, timeoutMs: 240000 },
      qwen: { size: [512, 1024, 64], steps: 20, refBase: 0.95, timeoutMs: 300000 }
    },
    /* 出厂三张模型卡,都是 ComfyUI Vibedraw Plugin(CVP)规范:
       快速生图 512、渲染出图 1024、Qwen 图像 2.1 512–1024。
       用户可以再"添加模型"加别的接口。
       needsEnglish = "这张卡只吃英文提示词,生图前要先把中文译成英文"。
       出厂一律 false:插件端自己就会译英(它拿到中文也会照画),所以默认不该多一次往返;
       用户在模型设置里给哪张卡打开开关,哪张卡才走本机的译英服务。 */
    models: [
      {
        id: "cvp-quick", name: "快速生图", protocol: "cvp", task: "quick",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        size: 512, steps: 8, refStrength: 100, growMaskBy: 8, quality: "low",
        needsEnglish: false, timeoutMs: 60000
      },
      {
        id: "cvp-render", name: "渲染出图", protocol: "cvp", task: "upscale",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        size: 1024, steps: 8, refStrength: 100, growMaskBy: 8, quality: "high",
        needsEnglish: false, timeoutMs: 240000
      },
      {
        /* Qwen 图像 2.1 是"照参考图作画",不是图生图:参考图权重调低不是少看点原稿,
           而是把原稿柔化,让提示词接手(插件里 refBase 0.95 就是原稿原样送进去)。 */
        id: "cvp-qwen", name: "Qwen 图像 2.1", protocol: "cvp", task: "qwen",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        size: 1024, steps: 20, refStrength: 100, growMaskBy: 8, quality: "high",
        needsEnglish: false, timeoutMs: 300000
      }
    ],
    activeModelId: "cvp-quick",
    /* 参考图固定 1024:交给模型的永远是 1024 边的干净渲染图,
       模型自己的 size(512–1024)只决定它输出多大 —— 两件事不要混。 */
    reference: { size: 1024 },
    /* size 与 refStrength 的可选范围,界面与校验共用这一份 */
    limits: { size: [512, 1024], refStrength: [0, 200], steps: [1, 40], timeoutMs: [5000, 300000] },
    maxResults: 12,
    render: {
      /* 造型 id。取值必须是 app/core/models.js 里登记过的,
         不在册的(旧版本存下来的)一律退回这一个(见 features/figure.js)。 */
      character: "ikea",
      background: "#f2f3f5"
    },
    generation: {
      prompt: "",
      negativePrompt: "low quality, distorted, extra limbs, watermark, text"
    }
  };

  app.config = null;
  app.platform = {};
  app.services = {};
  app.components = {};
  app.features = {};
})(window);
