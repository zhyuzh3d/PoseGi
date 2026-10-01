/* PoseGi 命名空间与全局状态
 *
 * 责任:建立 window.posegi,定义事件总线、运行时状态与默认配置的形状。
 * 约束:只放数据结构与全局单例,不含任何业务逻辑;core 层不碰 DOM。
 */
(function (global) {
  "use strict";

  var app = global.posegi = global.posegi || {};
  var listeners = {};

  /* 与 haminn.json 的 version.name 必须一致(tests/rig.test.mjs 守着)。
     上一轮发版只改了 haminn.json(code 3 / 0.1.1),这里漏了 —— 于是界面上
     顶着「v0.1.0」而装上去的包里写着 0.1.1。以 haminn.json 为准,这里跟上。 */
  app.version = "0.1.19";

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
   * 作品的边界(2026-09-25 用户定的形态,参照 hamdraw;2026-09-30 扩容):
   *   「作品」= 标题 + 提示词 + 属于它的历史成图(最多 12 张)
   *            + **这一件作品长什么样**(姿态 / 视口 / 模型卡 / 人偶造型)。
   *   前一半挂在作品下面,所以"成图跟随作品保存"是数据形状本身保证的;
   *   后一半在 `document` 里(见下),由 store 读写、由 app.js 装配给四个模块。
   *   换作品 = 换一组成图 + 换一次姿势与视角。 */
  app.state = {
    theme: app.THEME,
    selectedJoint: "",
    selectedPart: "bone",
    poseName: "",
    dirty: false,
    /* 当前作品的"文档部分":姿态 / 视口 / 模型卡 / 造型。
       形状与 store 写进作品记录里的那四个字段一模一样(见 store.snapshot),
       所以"装进来"与"存出去"读的是同一份东西,中间不做第二次换算。
       空作品(还没打开任何作品)是 null —— 装配层据它决定"回出厂姿态与出厂视口"。 */
    document: null,
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
    /* 上一次提交出去、但还没把图取回来的那个作业(见 services/providers.js 的
       chpSubmit / chpResume,以及 services/image-engine.js 的 resume)。

       它存在的理由是一次真实的事故:POST 已经把作业交给服务端了,可应答在回程
       丢了(宿主那一次读超时抛的裸 `timeout`),于是客户端手上既没有 job id、
       也没有图 —— 服务端画好的那张图再也没人能取回来。

       所以提交成功后**当场**把 job id 记在这里,并跟着作品落盘:进程被杀掉、
       手机重启,只要这件作品还在,就还能按这个 id 把图取回来。
       形状:{ jobId, base, task, requestId, createdAt }。取回成功、作业失败、
       作业被取消、作业在服务端消失 —— 四种结局都要把它清掉(见 clearPending)。 */
    pendingJob: null,
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
       所以这次迁移没有"补卡"这类结构动作,只用来标记版本。
       schema 4 → 5:CHP 的场景名换成插件自己的词(`quick`→`fast`、`qwen`→`render`),
       原因是插件的 CHP 2 协议取消了别名机制 —— 旧名字发过去不再是"另一个叫法",
       而是 `unsupported_category`。改名本身在 store.shapeModel 里做(它每次都过一遍),
       这一次 schema 只额外负责"出厂卡的名字也跟着换"。
       schema 5 → 6:**画幅从"一个正方边长"换成"一条 9:16 的分辨率字符串"**(用户 2026-09-30 定:
       宽高比一律锁 9:16)。字段 `size`(数字)换成 `resolution`("WxH"),老装机上存的那个
       正方边长在 store.shapeModel 里迁移;出厂默认激活卡同时从"快速生图"换成
       "高质量生图" —— 那时插件只有 render 公布了 9:16 档,详见下面 chpTasks 的注释。
       (2026-10-01 插件 3.1 把画幅那份表换成同一族模型的三档,并分出了 `generate`,
       render/generate 都有 9:16 —— 但那**不改持久化的形状**:新场景只是 chpTasks 多
       一个键、出厂卡一个都没加,所以 schema 不升。) */
    schema: 6,
    preferences: { theme: app.THEME, language: "system", lastWorkId: "" },
    /* 译英服务(2026-09-25 用户要求):只对"标记为需要英文"的生图模型生效。
       默认跟着 CHP 的连接走 —— 插件自带翻译大模型,地址与密码就是那一套;
       单独填了 endpoint 就以这份为准。enabled 只在"测试翻译成功"之后才为真,
       没测通就绝不拿它去拦生成(见 services/translate.js)。
       protocol 的取值见 translate.protocols:chp / openai(DeepSeek、Qwen 都是这个
       格式)/ claude / gemini(2026-09-26 用户要求支持这几家)。
       借生图连接那条路一定是 chp —— 生图只有 CHP 卡片共用一套地址。 */
    translate: { enabled: false, protocol: "chp", endpoint: "", apiKey: "", model: "", customHeaders: "" },
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
    /* CHP(ComfyUI Haminn Protocol)的连接是**一套**:地址、密码、自定义头。
       填一次,所有 protocol 为 chp 的模型卡一起生效 —— 插件本来就是一个进程,
       每张卡各填一份地址只会让人重复劳动,还会出现"两张卡填了不同地址"的鬼状态。
       非 CHP 的卡(OpenAI Images / SD WebUI / Stability)各有各的 endpoint。 */
    connection: { endpoint: "", apiKey: "", customHeaders: "" },
    /* 还没填过 CHP 地址时,「服务器地址」里预填的那条样例 —— 只有 IP 是要改的地方,
       所以它本身不是一个能直接用的地址,是给用户照着改的。
       (2026-09-26 用户要求:**已经填过就绝不去动它**,只在配置里还没有地址时才填这一条。) */
    chpEndpoint: "http://192.168.1.31:8189/chp",
    /* 宽高比**锁死 9:16**(2026-09-30 用户定):参考图、CHP 的画幅、别的接口的输出
       全部按竖屏构图。这不是"一个默认值",是产品口径 —— 所以它只有一个出处,
       谁都不许自己拼一个比例出来(旧的 `aspect_ratio: "1:1"` 那种写法也一并消掉)。 */
    ratio: "9:16",
    /* CHP 之外的接口能挑的分辨率。挑的是**大模型常见的 9:16 竖幅档**,从 SD1.5 时代
       的 512 到 Full HD 都在里面;每个值都是"宽x高",不是边长 —— 边长这个概念随
       正方画幅一起没了。
       (有些家的接口只认它自己那几张,比如 OpenAI Images 只有 1024x1536 一档竖幅、
       而且不是 9:16。那不是这里能兜的事:本应用锁 9:16,对不上就由对方报错。) */
    resolutions: ["512x912", "576x1024", "720x1280", "768x1344", "1024x1820", "1080x1920"],
    /* 每个场景的出厂参数:**这一份是唯一出处**,界面、store 的字段收口、providers 的
       请求组装都读它。键就是插件的场景名(`chp/2` 的 category)。
       画幅与步数**都不是用户可选项**:真画幅由插件公布的帧表决定(见 providers 的
       chpResolution),真步数由插件当前的加速档案决定(见下面「步数一行都不发」那段)。
       这里的 `resolution` / `steps` 只是"还没读过插件文档时的出厂值",而且**只填插件
       当前确实公布了的 9:16 档**:2026-10-01 起 `render` 与 `generate` 各有一张
       9:16 三档表(低 512x896 / 中 768x1344 / 高 896x1568,同一族模型的两条路、画幅
       一致);`fast` / `upscale` 仍然只有 1:1 与 4:3/3:4 —— 锁 9:16 之后它们在这台
       插件上出不了图,所以出厂值是空串,由界面明说"这个场景没有 9:16 画幅"。
       用户在插件配置节点里给它们加一档 9:16,这里就会自动跟着有(值来自插件,不是
       本应用写死的)。
       超时是本应用自己的取舍,参考图基准同理(插件会报自己的 default,以它为准)。 */
    chpTasks: {
      fast: { resolution: "", steps: 8, refBase: 0.55, timeoutMs: 60000 },
      upscale: { resolution: "", steps: 8, refBase: 0.75, timeoutMs: 240000 },
      /* `render` = **给定一张图重新生成**(插件的规则是 `txt-ref-2-img`,所以它必须
         带参考图);`generate` = **纯文字生成**(`txt-2-img`,收到参考图会被插件拒掉)。
         这正好对上本应用两条路:画布渲染出来的那张定妆照走 render;没有定妆照时走
         generate。步数那一列在这里只是个兜底,真步数由插件那台机器的加速档案定。 */
      render: { resolution: "768x1344", steps: 20, refBase: 0.95, timeoutMs: 300000 },
      generate: { resolution: "768x1344", steps: 20, refBase: 0.95, timeoutMs: 300000 }
    },
    /* 出厂三张模型卡,都是 CHP 插件规范。
       用户可以再"添加模型"加别的接口 —— 也包括 `generate`(纯文生图):插件播报了
       它,任务选择里就会出现那一个按钮(见 providers 的 chpCategories),只是出厂不摆
       一张卡:本应用的主线是"摆好姿势 → 拿渲染图当定妆照 → 重画",纯文生图不是这条线。
       (插件的 `generate` 不但不需要那张定妆照,而且**收到**它就会被拒 —— 见 providers
       的 chpGenerate。)
       id 是**历史遗留的字符串**(`chp-render` 指的是图像放大那张),它只是配置里的
       主键,不参与任何判断 —— 判断一律看 `task`。改 id 会让老装机上"哪张卡在用"
       这一条对不上,所以不动它。
       needsEnglish = "这张卡只吃英文提示词,生图前要先把中文译成英文"。
       出厂一律 false:插件端自己就会译英(它拿到中文也会照画),所以默认不该多一次往返;
       用户在模型设置里给哪张卡打开开关,哪张卡才走本机的译英服务。
       `resolution` 为空 = 插件当前没为这个场景公布 9:16 档(见上面 chpTasks)。 */
    models: [
      {
        id: "chp-quick", name: "快速生图", protocol: "chp", task: "fast",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        resolution: "", steps: 8, refStrength: 100, quality: "low",
        needsEnglish: false, timeoutMs: 60000
      },
      {
        id: "chp-render", name: "图像放大", protocol: "chp", task: "upscale",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        resolution: "", steps: 8, refStrength: 100, quality: "high",
        needsEnglish: false, timeoutMs: 240000
      },
      {
        /* 高质量生图那一路是"照参考图重新作画",不是图生图:参考图权重调低不是
           少看点原稿,而是把原稿柔化,让提示词接手(插件的 refBase 0.95 就是原稿
           原样送进去)。它对中文也照画,所以这张卡默认也不需要译英。
           出厂激活的是**这一张**:本应用的主线就是它 —— 画布上摆好的那个姿势渲染出来
           当定妆照,再按提示词重画。`generate`(纯文生图)那张卡出厂不摆,理由见上面。 */
        id: "chp-qwen", name: "高质量生图", protocol: "chp", task: "render",
        endpoint: "", apiKey: "", model: "", customHeaders: "",
        resolution: "768x1344", steps: 20, refStrength: 100, quality: "high",
        needsEnglish: false, timeoutMs: 300000
      }
    ],
    activeModelId: "chp-qwen",
    /* 参考图 = **画布渲染一张,再居中裁到 9:16,缩到高度 1024**,交出去的就是 576×1024
       (用户 2026-09-30 定:9:16 锁定、居中裁切、最终高度 1024)。
       画布先按 `canvasWidth × canvasHeight` 渲 —— 比 9:16 略高一点,`.height` 那份
       余量是给"居中裁"留的上下两条(裁切算法在 viewport.captureAt 里,它对**横向
       富余**同样处理:画布万一比 9:16 宽,它就从左右两侧居中裁)。
       1080 这个数不是拍的:真机上量过小人底边恒在画布高度的 **91.3%** 处
       (换宽高比也不动:three.js 的 fov 是竖直的)。1080 居中裁到 1024 只切掉上下
       各 28 行,人不会少一截;而裁完高度正好是 1024,连缩放都不用做。 */
    reference: { canvasWidth: 576, canvasHeight: 1080, width: 576, height: 1024 },
    /* 可选范围,界面与校验共用这一份。画幅不在这里 —— 它是"必须命中清单"的成员校验,
       不是区间(见 providers 的 validate)。 */
    limits: { refStrength: [0, 200], steps: [1, 40], timeoutMs: [5000, 300000] },
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
