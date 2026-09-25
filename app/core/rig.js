/* 骨骼与姿态数据模型:纯数据与纯数学,不碰 DOM,不依赖 three.js
 *
 * 骨架的**尺寸与朝向来自人物模型**(app/assets/models/*.js,离线生成),不是写死的:
 * 每个模型自带 20 个关节的 offset / rest / length / radius,由 applyModel() 在启动时
 * 写进下面的关节表。本文件只负责"骨架怎么用",不负责"骨架长什么样"。
 *
 * 约定(与离线转换器 tools/import-model.py 的输出逐字对应):
 *   - 每个关节的骨骼从关节点沿自身局部 +Y 方向延伸 length。
 *   - offset 是相对父关节原点的局部位移,写在父关节的局部坐标系里。
 *   - rest 是静止姿态下的局部欧拉角(度),即默认站姿。**不保证是 0**:
 *     模型给的数值解出来的角度可能是任意值(宜家的脚踝 rest x 就是 65 度)。
 *   - 姿态 = { 关节名: { x: 度, y: 度, z: 度 } },只有角度,没有位置。
 *
 * 层级(自外向内):
 *   world(场景) → bbox(人物子空间,可整体搬运) → broot(骨架顶层,转身/挪位)
 *   → hips(骨盆) → spine / thigh.L / thigh.R → ...
 *   bbox 不在这张表里,它是场景层的容器;broot 是骨架顶层且没有可渲染的骨骼。
 *
 * 关节命名:成对的肢体一律用 .L / .R 后缀,L 是角色自身的左侧(世界 +X)。
 *         这样镜像、左右同步、左右互换才有唯一解。
 *
 * 单位:米。人物模型统一缩放到高约 1.74m,脚底 y = 0。
 * 渲染在 app/components/viewport.js,本文件只负责"姿态是什么"。
 */
(function (app) {
  "use strict";

  /* 关节表(骨架里"与几何无关"的那一半)。
   *
   * 位置 / 静止姿态 / 骨长 / 零件尺寸**不在这里** —— 它们来自人物模型
   * (app/assets/models/*.js,由 tools/import-model.py 离线生成),由 applyModel()
   * 在启动时写进来。本表只保留"模型不负责"的那些字段:
   *
   *   node        这个关节有可抓的把手球(肩、肘、腕、髋、膝、踝)。球默认由视口画在
   *               关节原点上,尺寸与模型无关(一律用 viewport 的 NODE_RADIUS),
   *               而且**平时藏着、选中这个关节才显示**;写了 nodeFrom 的关节例外,见下。
   *   nodeFrom    "model" 表示这个关节的把手球**用模型自带的那颗**,视口不再另画。
   *               目前只有肩:宜家的 shoulder.L / shoulder.R 件本身就是一颗 42 顶点的球,
   *               比我们画的球(半径 0.0531)大一点,另画一颗就会在肩上叠出两颗
   *               互相穿插的球(用户反馈过)。
   *               **这颗球的球心必须落在关节原点上** —— 视口与命中的锚点取的就是
   *               关节原点,球心一偏锚点跟着偏,表现成"看着点在球上却掉进空地"。
   *               之前靠 nodeOffset 补偿(模型那颗球偏出 4.7cm = 屏幕上 23px,
   *               而屏幕容差只有 33px ⇒ 球的外半边点不到);骨架按人体测量学校正后
   *               球心已归零(实测球块质心 0.0mm),补偿连同这个字段一起删了。
   *               这条不变量由 tests/ik.test.mjs 守着(直接量球块质心)。
   *   grab        拖这颗球算什么:"node" 移动(走 IK)/ "bone" 旋转。
   *               不写就按"有没有上游关节可转"推出来。
   *   meshGrab    拖这一整块零件网格算什么。不写就与 grab 同义。
   *               手与脚要写 "bone":腕球、踝球是"移动端"(把整条胳膊/腿拉过去),
   *               而那一整块手掌、脚掌自己抓住时要能转角度,两者必须分开。
 *   limit       该关节自身的可转范围(度),记的是**相对静止姿态**的增量,不是绝对角度 ——
 *               rest 来自模型,可能是任意值(宜家的脚踝 rest x 就是 65 度)。不写 = 全局 ±180。
 *
 *   ==== 三个通道的解剖学含义(2026-09-25 逐关节数值实测,不是"按常理"猜的)====
 *   骨骼沿各自局部 +Y 生长,所以 **y 恒等于"绕骨轴自转"**;
 *   另两轴的指向按"绕它转 +10 度,骨末端往哪挪"读出来:
 *
 *     x   +x → 末端朝 +Z(角色面朝的前方)走
 *           四肢 = 前摆 / 屈;躯干与头 = 前屈(低头、弯腰)
 *     z   躯干(hips / spine / chest / neck / head):+z → 末端朝 -X ⇒ +z = 向角色的**右**侧倾
 *         四肢(肩 / 臂 / 腿 / 脚):                +z → 末端朝 +X ⇒ +z = 朝角色的**左**边走
 *         (两者的差别只是骨头的朝向相反:躯干的骨朝上,四肢的骨朝下,
 *          绕同一根世界轴转,末端自然往相反的方向去。)
 *     y   +y → 躯干与头的面朝方向转向 +X(角色自身的左侧)⇒ +y = 向左转;
 *           四肢: 绕骨轴拧(左腿 +y 是内旋,右腿 +y 是外旋 —— 与 z 的镜像规律一致)
 *
 *   两条由此而来的硬规则,写 limit 时不许违反:
 *     1) **左右只在 y 与 z 上互为相反数,x 完全一致**(mirror() 就是这么定义的)。
 *        所以 .R 的 limit 一律由 mirroredLimit(左侧) 生成,不要手抄一遍 ——
 *        抄错就是把"右腿外展"写成"内收",真机上表现为一条腿能往左跨、另一条不能。
 *     2) 反关节的唯一入口就是这个窗口,所以**单侧的通道必须写成单侧窗口**
 *        (膝的 x 上界是 0、肘的 x 下界是 0),不许图省事写成 ±180。
 *   pivot       纯变换节点,没有可渲染的骨骼。
   *   label       界面上的中英文名。
   *
   * 关节命名:成对的肢体一律用 .L / .R 后缀,L 是角色自身的左侧(世界 +X)。
   *         这样镜像、左右同步、左右互换才有唯一解。
   */
  /* 把左侧的限位翻成右侧:x 不变,y 与 z 取反并交换上下界 —— 与 mirror() 同一套规则。
     成对关节的 limit 一律走这里生成,手抄一遍迟早抄成"外展写成内收"。 */
  function mirroredLimit(limit) {
    var flip = function (range) { return [-range[1], -range[0]]; };
    return { x: [limit.x[0], limit.x[1]], y: flip(limit.y), z: flip(limit.z) };
  }

  var JOINTS = [
    /* 变换节点:只承载变换。参考系自外向内:world → bbox → broot → hips → 其余关节。
       bbox 不在本表里,它是场景层的容器(见 viewport.js)。

       它**自己不旋转、也不移动** —— 姿态里根本没有位移通道,旋转也不归它:
       拖它就是"整体搬运"(移动 bbox,见 viewport 里 isPivot 的分支),
       人物的整体旋转归 hips(转 hips 会带动脊柱与双腿,等于绕骨盆转一圈)。
       node 是给它的搬运把手(视口画的小八面体)要一份屏幕容差 ——
       它落在脚底中心,不给容差就会被踝球抢走(实测点过去命中的是 foot.R)。

       limit 三个通道都是零宽:这是把"broot 不可旋转"从**视口的约定**升级成
       **数据结构上做不到** —— 姿态格式里每个关节都有三个角度槽,不给零宽窗口的话
       存档、镜像、脚本写入都还能把 broot 转起来(视口只是不给你拖而已)。 */
    { name: "broot", parent: "", pivot: true, node: true,
      limit: { x: [0, 0], y: [0, 0], z: [0, 0] }, label: ["源点", "Body root"] },

    /* 骨盆。它是**全身的转向盘**(用户定的):y 给满 ±180,想让角色面朝哪边就转它。
       注意 hips 是两条腿的父关节,所以转 hips 会连腿一起带走 —— 这正是"绕骨盆转身"
       应有的样子(而不是 broot 去转)。x / z 是骨盆自身的前后倾与左右倾,骨盆不是
       万向节,按实际活动度收窄。 */
    { name: "hips", parent: "broot",
      limit: { x: [-25, 25], y: [-180, 180], z: [-20, 20] }, label: ["骨盆", "Hips"] },
    /* 腰(腰椎)。轴向旋转极小(腰椎的轴向旋转实测只有十几度,躯干转向靠胸椎),
       前屈比后伸大得多。 */
    { name: "spine", parent: "hips",
      limit: { x: [-35, 15], y: [-15, 15], z: [-25, 25] }, label: ["腰", "Spine"] },
    /* 胸(胸椎)。前屈 40 / 后伸 25 / 轴向旋转 40(躯干旋转的主力)/ 侧屈 30。
       三节躯干叠起来:前屈 100、后伸 65、旋转 55、侧屈 75 —— 都是整条脊柱的实数。 */
    { name: "chest", parent: "spine",
      limit: { x: [-40, 25], y: [-40, 40], z: [-30, 30] }, label: ["胸", "Chest"] },
    /* 颈(颈椎):前屈 35 / 后伸 40 / 旋转 50 / 侧屈 30。与头合起来是
       前屈 55、后伸 65、旋转 80、侧屈 45 —— 正好是颈部总活动度。 */
    { name: "neck", parent: "chest",
      limit: { x: [-35, 40], y: [-50, 50], z: [-30, 30] }, label: ["颈", "Neck"] },
    /* 头(枕颈关节):只给点头与少量侧头,大范围转身是颈的事。
       头没有画球:整块头就是零件本身,抓住它就是挪头(靠 grab 声明)。 */
    { name: "head", parent: "neck", grab: "node",
      limit: { x: [-20, 25], y: [-30, 30], z: [-15, 15] }, label: ["头", "Head"] },

    /* 肩球不能"抓着走":它直接挂在胸上,要让肩移动就得整段躯干跟着走,所以退回旋转
       (见 grabMode:链为空就退旋转)。肘球、腕球在链上,可以走。
       肩的把手球直接用**模型自带的那颗**(宜家的 shoulder.L 件本身就是一颗 42 顶点的球),
       球心已归零 = 关节原点,所以视口的命中锚点不需要任何偏移补偿(见文件头的 nodeFrom)。 */
    /* 肩(肩胛段)与上臂(肱骨段)是**同一套局部轴**(上臂的 rest 是 0,它的轴就是肩的轴),
       所以两者的 z 可以直接相加:外展 60 + 125 = 185(解剖上限 180)、
       前屈 60 + 125 = 185(上限 180)、后伸 20 + 45 = 65(实际上限 60)。
       拆成两节各给一段,是为了让"把胳膊举到侧面"与"把胳膊往前举"都能落在
       解剖范围的内部,而不是让某一节独自吃掉整个行程。 */
    { name: "shoulder.L", parent: "chest", node: true, nodeFrom: "model",
      limit: { x: [-20, 60], y: [-30, 30], z: [-10, 60] }, label: ["左肩", "Left shoulder"] },
    { name: "upperArm.L", parent: "shoulder.L",
      limit: { x: [-45, 125], y: [-70, 70], z: [-35, 125] }, label: ["左上臂", "Left upper arm"] },
    /* 肘。人体肘只有两个自由度:x 是铰链(**只许屈,下界 0 = 一度都不许反张**),
       y 是前臂的旋前旋后(85 度)。z 是"把前臂往侧面掰",人体做不到,
       只留 10 度容差给欧拉分解的误差,不要当成可用通道。 */
    { name: "forearm.L", parent: "upperArm.L", node: true,
      limit: { x: [0, 145], y: [-85, 85], z: [-10, 10] }, label: ["左前臂", "Left forearm"] },
    /* 腕:球可拖(走 IK 把整条胳膊拉过来),掌自己可转。
       范围按腕关节实际活动度:掌屈约 80 度(+x,实测末端朝前)、背伸约 70 度(-x)、
       桡尺偏约 25 度、绕骨轴几乎不能自转(y 只留 25 度容差,那是前臂旋前旋后的事)。 */
    { name: "hand.L", parent: "forearm.L", node: true, grab: "node", meshGrab: "bone",
      limit: { x: [-70, 80], y: [-25, 25], z: [-25, 25] }, label: ["左手", "Left hand"] },

    /* 右肩同左肩:用模型自带的那颗球,球心同样在关节原点上(不需要偏移补偿);
       限位由左侧翻过来生成 —— 右侧的 +z 是"朝角色左边",也就是内收,不能照抄左边。 */
    { name: "shoulder.R", parent: "chest", node: true, nodeFrom: "model",
      limit: mirroredLimit({ x: [-20, 60], y: [-30, 30], z: [-10, 60] }),
      label: ["右肩", "Right shoulder"] },
    { name: "upperArm.R", parent: "shoulder.R",
      limit: mirroredLimit({ x: [-45, 125], y: [-70, 70], z: [-35, 125] }),
      label: ["右上臂", "Right upper arm"] },
    { name: "forearm.R", parent: "upperArm.R", node: true,
      limit: { x: [0, 145], y: [-85, 85], z: [-10, 10] }, label: ["右前臂", "Right forearm"] },
    { name: "hand.R", parent: "forearm.R", node: true, grab: "node", meshGrab: "bone",
      limit: { x: [-70, 80], y: [-25, 25], z: [-25, 25] }, label: ["右手", "Right hand"] },

    /* 髋。前屈 120 / 后伸 25 / 内旋 45 / 外旋 45。
       z 是单侧窗口:左侧 +z 朝角色左边走 = **外展 45**,往右 = 内收 30(再往里就穿到另一条腿上了)。 */
    { name: "thigh.L", parent: "hips", node: true,
      limit: { x: [-25, 120], y: [-45, 45], z: [-30, 45] }, label: ["左大腿", "Left thigh"] },
    /* 膝。**单轴铰链**:x 是唯一的通道(上界 0 = 一度都不许反张),屈到 150。
       y 是屈膝时才有的小腿轴向旋转(20),z 是侧向掰(6)—— 给一点点容差,
       但膝的"反关节"只要看 x 的上界就够了,那是唯一的入口。 */
    { name: "shin.L", parent: "thigh.L", node: true,
      limit: { x: [-150, 0], y: [-20, 20], z: [-6, 6] }, label: ["左小腿", "Left shin"] },
    /* 踝:球可拖(把整条腿拉过来),脚掌自己可转。
       范围按踝关节实际活动度:勾脚背约 20 度(+x,实测末端往上走)、绷脚背约 50 度(-x)、
       内外翻约 20 度、脚尖内外摆约 20 度。 */
    { name: "foot.L", parent: "shin.L", node: true, grab: "node", meshGrab: "bone",
      limit: { x: [-50, 25], y: [-20, 20], z: [-20, 20] }, label: ["左脚", "Left foot"] },

    /* 右腿:限位由左侧翻过来(x 一致,y / z 取反)—— 右侧的 +z 是朝角色左边,
       也就是内收,直接抄左边的窗口会把"外展"写成"内收"。 */
    { name: "thigh.R", parent: "hips", node: true,
      limit: mirroredLimit({ x: [-25, 120], y: [-45, 45], z: [-30, 45] }),
      label: ["右大腿", "Right thigh"] },
    { name: "shin.R", parent: "thigh.R", node: true,
      limit: { x: [-150, 0], y: [-20, 20], z: [-6, 6] }, label: ["右小腿", "Right shin"] },
    { name: "foot.R", parent: "shin.R", node: true, grab: "node", meshGrab: "bone",
      limit: { x: [-50, 25], y: [-20, 20], z: [-20, 20] }, label: ["右脚", "Right foot"] }
  ];

  /* 躯干关节:IK 往上爬的时候,只有"从躯干出发"的拖动才允许穿过它们。
     原因见 ikChain 的注释。 */
  var TRUNK = { hips: true, spine: true, chest: true };
  var TRUNK_ORIGIN = { head: true, neck: true, chest: true, spine: true };

  var LIMITS = { min: -180, max: 180 };
  var ANGLE_KEYS = ["x", "y", "z"];
  var RIG_HEIGHT = 1.74;
  var ZERO = [0, 0, 0];

  /* 预设姿态:只写与默认站姿不同的关节,**值一律是"相对 rest 转多少度"**。
     出厂小人的 rest 大多是 0,相对与绝对恰好重合;但换成外部模型时 rest 是它自己的
     绑定姿态(肩、髋可能是 180 或别的解出来的角度),写绝对值会让整套预设失效。
     角度值按"角色左侧为 +X、面向 +Z"推得,渲染器就位后需要在设备上逐条目视确认。 */
  var PRESETS = [
    { id: "stand", label: ["站姿", "Stand"], patch: {} },
    {
      id: "tpose",
      label: ["T 字", "T pose"],
      /* 外展 90 度拆成肩 32 + 上臂 58 —— 两节各走一段,谁都不越自己的界
         (肩的外展上限是 60)。实测手落点与旧版"肩独吃 90 度"一致(0.924 vs 0.925 米)。 */
      patch: {
        "shoulder.L": { z: 32 }, "upperArm.L": { z: 58 },
        "shoulder.R": { z: -32 }, "upperArm.R": { z: -58 }
      }
    },
    {
      id: "walk",
      label: ["行走", "Walk"],
      /* 左腿在前、右臂在前(对侧摆臂)。**膝一律写负 x**:膝只许向后弯,
         旧版把右膝写成 +35,那是膝反张,限制上线后会被直接夹成直腿。 */
      patch: {
        spine: { y: 6 },
        "thigh.L": { x: 28 }, "shin.L": { x: -22 },
        "thigh.R": { x: -24 }, "shin.R": { x: -34 },
        "shoulder.L": { x: -18 }, "shoulder.R": { x: 18 },
        "forearm.L": { x: 28 }, "forearm.R": { x: 25 }
      }
    },
    {
      id: "wave",
      label: ["举手", "Wave"],
      /* 左手沿额状面举到头顶:外展 60 + 105 = 165,肘再屈 26。
         旧版用 shoulder.L 的 x 往后甩 130 度去"举手",那是肩后伸 130 度,
         解剖上不存在(实际后伸约 60),而且现在会被 x 的上界直接夹掉。 */
      patch: {
        head: { z: -6 },
        "shoulder.L": { z: 60 }, "upperArm.L": { z: 105 }, "forearm.L": { x: 26 },
        "shoulder.R": { x: 10 }, "forearm.R": { x: 22 }
      }
    },
    {
      id: "sit",
      label: ["坐下", "Sit"],
      /* 髋前屈 86(大腿转到水平向前)、膝屈 86(小腿垂下)、踝略背屈让脚掌放平。
         两个符号要分清:**髋是 +x,膝是 -x**。旧版写反了 ——
         旧 sit 的大腿是向后伸的、小腿是反张的,越想"坐下"越像跪着往后翻。
         姿态格式没有位移通道,骨盆降不下去,所以这是个"坐在高凳上"的样子。 */
      patch: {
        hips: { x: -8 }, spine: { x: 10 }, chest: { x: 6 },
        "thigh.L": { x: 86 }, "shin.L": { x: -86 }, "foot.L": { x: -6 },
        "thigh.R": { x: 86 }, "shin.R": { x: -86 }, "foot.R": { x: -6 },
        "shoulder.L": { x: 8 }, "shoulder.R": { x: 8 }
      }
    }
  ];

  var index = {};
  JOINTS.forEach(function (joint) { index[joint.name] = joint; });

  var activeModel = null;

  function rebuildIndex() {
    index = {};
    JOINTS.forEach(function (joint) { index[joint.name] = joint; });
  }

  /* 装上人物模型的骨架参数。这是骨架尺寸与静止姿态的**唯一来源** ——
     关节表里只写"怎么抓、能转多少",位置与朝向一律来自这里。
     覆盖 offset / rest / length / radius 四项,其余字段一律不动。
     调用方负责在装完之后重建视口(app/features/figure.js 是唯一出口)。 */
  function applyModel(model) {
    var next = model && model.joints ? model : null;
    /* + 0 把负零折叠成 0:模型里写着 -0 的地方会让姿态比对与落盘结果出现
       无意义的差异(JSON 与 deepEqual 都把 -0 与 0 当两个值)。 */
    var flat = function (values, fallback) {
      if (!values) return fallback.slice();
      return [Number(values[0]) + 0, Number(values[1]) + 0, Number(values[2]) + 0];
    };
    JOINTS.forEach(function (joint) {
      var source = next ? next.joints[joint.name] : null;
      /* 模型里没有这个关节时退化成"原点上的零长节点":骨架会明显塌掉,
         一眼就能看出是模型数据缺了,而不是静默地拿一套写死的数字顶上。 */
      joint.offset = flat(source && source.offset, ZERO);
      joint.rest = flat(source && source.rest, ZERO);
      joint.length = source ? Number(source.length) : 0;
      joint.radius = source ? Number(source.radius) : 0;
    });
    rebuildIndex();
    activeModel = next;
    return activeModel;
  }

  function model() { return activeModel; }

  function byName(name) { return index[name] || null; }

  function names() { return JOINTS.map(function (joint) { return joint.name; }); }

  function isPaired(name) { return /\.(L|R)$/.test(String(name || "")); }

  /* 纯变换节点:没有可渲染的骨骼长度与半径 */
  function isPivot(name) {
    var joint = byName(name);
    return Boolean(joint && joint.pivot);
  }

  /* 参考系名字:bbox 是场景层容器,broot 是骨架顶层,其余为关节名,"world" 是世界 */
  var BBOX = "bbox";

  function isTrunk(name) { return TRUNK[String(name || "")] === true; }

  /* 是否在关节原点画一颗可抓的球 */
  function isNode(name) {
    var joint = byName(name);
    return Boolean(joint && joint.node);
  }

  /* 【球】拖关节原点上那颗球算移动还是旋转。
   * 判据不是"有没有球",而是"抓起来走不走得动":链为空(肩球)时移动无从谈起,只能旋转。
   *   grab 字段是显式指定(头没有画球,但抓头当然是挪头),它优先;
   *   其余按 node + 上游有没有可转的关节推出来。
   * 这一处判定是唯一出处 —— 命中检测与高亮都问它,才不会各说各话。 */
  function grabMode(name) {
    var joint = byName(name);
    if (!joint) return "bone";
    if (joint.grab === "bone") return "bone";
    if (joint.grab === "node") return ikChain(name).length ? "node" : "bone";
    if (!joint.node) return "bone";
    return ikChain(name).length ? "node" : "bone";
  }

  /* 【零件网格】拖这一整块网格算旋转还是移动。
   *
   * 与 grabMode 是两件不同的事,曾经混成一个函数,真机上直接表现为
   * "小臂、小腿选不中":那几根的网格被判成 node,于是点小臂中间等于去拽肘球,
   * 网格本身既转不动、高亮也落在小球上,看上去就是没选中。
   *
   * 规则:网格默认就是"转"——小臂、小腿、大腿、上臂、颈、脊柱都归旋转;
   *   meshGrab 是显式指定,用来把某一块网格单独拨回旋转或移动。
   *   目前只有"手"与"脚"写它:它们同时有腕球/踝球,球走 IK 把肢体拉过去,
   *   而手掌、脚掌这一整块抓住要能自己转角度 —— 两半必须分开。
   *   头没有球,grab: "node" 让它整块跟着走(挪头),不写 meshGrab。 */
  function boneGrab(name) {
    var joint = byName(name);
    if (!joint) return "bone";
    if (joint.meshGrab) return joint.meshGrab;
    if (joint.grab !== "node") return "bone";
    return ikChain(name).length ? "node" : "bone";
  }

  /* IK 链:拖动某个节点时要转动哪些关节。返回顺序是从根到末端(供 CCD 使用)。
   *
   * 规则:
   *   - 肢体(手、脚、膝、肘…):只走肢体链,碰到躯干就停。
   *     例:hand.L → [shoulder.L, upperArm.L, forearm.L];foot.L → [thigh.L, shin.L]。
   *   - 躯干(头、颈、胸、腰):沿脊柱往上走。
   *     例:head → [spine, chest, neck](转头、点头由颈负责,身子跟着让位)。
   *   - hips 与 broot 永远不进链:骨盆一动,全身连脚都跟着走,那是"搬运"该干的事。
   *   - 链为空表示这个节点没有可转的上游关节(例如肩球),调用方应退回旋转操作。 */
  function ikChain(name) {
    var joint = byName(name);
    if (!joint) return [];
    var fromTrunk = TRUNK_ORIGIN[joint.name] === true;
    var chain = [];
    var current = joint.parent;
    while (current && current !== "broot" && current !== "hips") {
      var parentJoint = byName(current);
      if (!parentJoint) break;
      if (isTrunk(current)) {
        if (!fromTrunk) break;
        chain.push(current);
      } else {
        chain.push(current);
      }
      current = parentJoint.parent;
    }
    return chain.reverse();
  }

  function mirrorName(name) {
    var value = String(name || "");
    if (/\.L$/.test(value)) return value.replace(/\.L$/, ".R");
    if (/\.R$/.test(value)) return value.replace(/\.R$/, ".L");
    return value;
  }

  /* 全局角度收口:先夹到 ±180,再归一化到 (-180, 180]。
     契约是"越界即收到上限"(999 → 180),normalize() 的调用方与测试都靠这一条。
     注意与 applyPreset 的分工:预设是"rest + 增量",增量和可能超过一圈(180 + 90),
     那种情况要**绕回来**(-90)而不是停在 180,所以预设自己在叠加处先归一化一次。 */
  function clampAngle(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    return app.utils.normalizeAngle(Math.min(LIMITS.max, Math.max(LIMITS.min, number)));
  }

  /* 某个关节某个通道的收口,**姿态写入的唯一收口点**(poser 的三个写入口、ik 的
     clampChannel、normalize 与 applyPreset 都走这里)。
   *
   * 关节可以在表里写 limit: { x: [min, max] },记的是**相对静止姿态**的增量,不是绝对角度 ——
   * rest 来自模型,可能是任意值(宜家的脚踝 rest x 就是 65 度),写绝对角度会一上来就被夹飞。
   * 没写 limit 的关节沿用全局 ±180。
   *   先减 rest 得到"相对静止姿态转了多少",夹进窗口,再加回去。
   * 窗口窄的时候不能先夹后归一化:手腕只有 ±70,输入 100 要顶住 70,不能绕成 -100。 */
  function clampJoint(name, key, value) {
    var joint = byName(name);
    var number = Number(value);
    if (!isFinite(number)) return 0;
    if (!joint) return clampAngle(number);
    var range = joint.limit ? joint.limit[key] : null;
    if (!range) return clampAngle(number);
    var rest = Number(joint.rest[ANGLE_KEYS.indexOf(key)]) || 0;
    var delta = app.utils.normalizeAngle(number - rest);
    return app.utils.normalizeAngle(rest + app.utils.clamp(delta, range[0], range[1]));
  }

  /* 某个关节某个通道的**可转窗口**,口径与 limit 完全一致(相对静止姿态的增量)。
     滑杆拿它当行程 —— 窗口画出来,边界才是看得见的:
     行程写死 ±180 而夹取发生在 clampJoint 里时,旋钮会停在 180、角度却是 20(实测过,
     拖拽期间 syncJointPanel 还会跳过正在聚焦的滑杆,所以这个不一致要松手之后才被纠正)。
     没写 limit 的关节沿用全局 ±180。返回一份拷贝,调用方改不动关节表。 */
  function jointRange(name, key) {
    var joint = byName(name);
    var range = joint && joint.limit ? joint.limit[key] : null;
    if (!range) return [LIMITS.min, LIMITS.max];
    return [range[0], range[1]];
  }

  /* 绝对角度 ⇄ 相对静止姿态的增量。**两个方向必须成对用**:
     clampJoint 就是在增量空间里夹取的,而姿态里存的是绝对角度。
     滑杆显示增量、写回绝对角度,两边共用这一对函数才不会差一个 rest ——
     脚踝的 rest 是 65 度、大腿的 rest z 是 -178.7 度,差起来很显眼。
     注:增量的归一化区间是 (-180, 180],所以恰好 -180 会被折成 +180;
     只有可转满半圈的关节(骨盆的转身)会碰到,而那两个方向本来就是同一个朝向。 */
  function relativeAngle(name, key, value) {
    var joint = byName(name);
    var number = Number(value);
    if (!joint || !isFinite(number)) return 0;
    var rest = Number(joint.rest[ANGLE_KEYS.indexOf(key)]) || 0;
    return app.utils.normalizeAngle(number - rest);
  }

  function absoluteAngle(name, key, delta) {
    var joint = byName(name);
    var number = Number(delta);
    if (!joint) return 0;
    var rest = Number(joint.rest[ANGLE_KEYS.indexOf(key)]) || 0;
    if (!isFinite(number)) return app.utils.normalizeAngle(rest);
    return app.utils.normalizeAngle(rest + number);
  }

  /* 默认站姿 = 每个关节的 rest 角度。
     过一遍 normalizeAngle:姿态里所有角度都是"归一化到 (-180,180]、保留一位小数"的,
     默认站姿也不例外。否则"新建的姿态"与"写入过一次的姿态"会差在最后一位小数上,
     镜像、序列化往返、与默认姿态比对都会莫名其妙地不相等(模型给的 rest 有四位小数)。 */
  function defaultAngles() {
    var angles = {};
    JOINTS.forEach(function (joint) {
      angles[joint.name] = {
        x: app.utils.normalizeAngle(joint.rest[0]),
        y: app.utils.normalizeAngle(joint.rest[1]),
        z: app.utils.normalizeAngle(joint.rest[2])
      };
    });
    return angles;
  }

  /* 归一化姿态:不认识的关节丢弃,越界角度收敛到该关节自己的可转范围 */
  function normalize(angles) {
    var source = angles || {};
    var result = defaultAngles();
    JOINTS.forEach(function (joint) {
      var value = source[joint.name];
      if (!value) return;
      ANGLE_KEYS.forEach(function (key) {
        if (value[key] === undefined || value[key] === null) return;
        result[joint.name][key] = clampJoint(joint.name, key, value[key]);
      });
    });
    return result;
  }

  /* 套用预设。
     预设是一整套姿态,所以从"默认站姿"起算,而不是叠在当前姿态上——
     否则先点 T 字再点行走,肩的 z 会留下来,手臂一直横着。
     起点是 rest(默认站姿),预设里的值再叠加上去 —— 于是同一份预设对任何模型都成立
     (不同模型的 rest 完全不同)。
     找不到这个预设时不动传入的姿态。 */
  function applyPreset(angles, presetId) {
    var preset = null;
    PRESETS.forEach(function (item) { if (item.id === presetId) preset = item; });
    if (!preset) return normalize(angles);
    var result = defaultAngles();
    Object.keys(preset.patch).forEach(function (name) {
      if (!index[name]) return;
      ANGLE_KEYS.forEach(function (key) {
        if (preset.patch[name][key] === undefined) return;
        /* 先归一化再收口:rest 可能本身就是 180,加上 90 得 270,
           那要绕成 -90 而不是停在 180 —— 否则"抬手"看起来完全没反应。 */
        result[name][key] = clampJoint(name, key,
          app.utils.normalizeAngle(result[name][key] + preset.patch[name][key])
        );
      });
    });
    return result;
  }

  /* 左右镜像:跨 X=0 平面反射后 Rx 保持、Ry 与 Rz 取反,关节名左右互换 */
  function mirror(angles) {
    var source = normalize(angles);
    var result = {};
    Object.keys(source).forEach(function (name) {
      var angle = source[name];
      result[mirrorName(name)] = { x: angle.x, y: clampAngle(-angle.y), z: clampAngle(-angle.z) };
    });
    return normalize(result);
  }

  /* ---- 3x3 旋转矩阵:行主序,作用于列向量,先绕 X,再绕 Y,最后绕 Z ---- */

  function rotationMatrix(angle) {
    var x = angle ? Number(angle.x) * Math.PI / 180 : 0;
    var y = angle ? Number(angle.y) * Math.PI / 180 : 0;
    var z = angle ? Number(angle.z) * Math.PI / 180 : 0;
    var cx = Math.cos(x), sx = Math.sin(x);
    var cy = Math.cos(y), sy = Math.sin(y);
    var cz = Math.cos(z), sz = Math.sin(z);
    var rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
    var ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
    var rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
    return multiply(rz, multiply(ry, rx));
  }

  function multiply(a, b) {
    var result = [];
    for (var row = 0; row < 3; row += 1) {
      for (var column = 0; column < 3; column += 1) {
        result[row * 3 + column] =
          a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column];
      }
    }
    return result;
  }

  function apply(matrix, vector) {
    return [
      matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
      matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
      matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
    ];
  }

  /* 某个关节的局部 +Y 在它自己父空间里的方向 */
  function localUp(angle) {
    var vector = apply(rotationMatrix(angle), [0, 1, 0]);
    return { x: vector[0], y: vector[1], z: vector[2] };
  }

  /* 前向运动学:每个关节在骨架局部空间(bbox 局部,broot 原点)的起点与朝向。
     origin 是 { x, y, z } 对象,orientation 是 3x3 行主序矩阵 —— IK 需要朝向才能把
     "在 bbox 空间里该怎么转"换算回关节自己的欧拉角。
     渲染不走这里:viewport 直接建 Object3D 层级,由矩阵乘法得到同样的结果。
     JOINTS 的顺序保证父关节先于子关节出现。 */
  function frames(angles) {
    var pose = normalize(angles);
    var result = {};
    JOINTS.forEach(function (joint) {
      var local = rotationMatrix(pose[joint.name]);
      var parent = joint.parent ? byName(joint.parent) : null;
      if (!parent) {
        result[joint.name] = {
          origin: { x: joint.offset[0], y: joint.offset[1], z: joint.offset[2] },
          orientation: local
        };
        return;
      }
      var parentFrame = result[parent.name];
      var moved = apply(parentFrame.orientation, joint.offset);
      result[joint.name] = {
        origin: {
          x: parentFrame.origin.x + moved[0],
          y: parentFrame.origin.y + moved[1],
          z: parentFrame.origin.z + moved[2]
        },
        orientation: multiply(parentFrame.orientation, local)
      };
    });
    return result;
  }

  /* 每个关节的起点与末端(末端 = 起点 + 朝向 × 局部 +Y × length),供取景、命中检测与测试使用 */
  function jointPositions(angles) {
    var computed = frames(angles);
    var positions = {};
    JOINTS.forEach(function (joint) {
      var frame = computed[joint.name];
      var moved = apply(frame.orientation, [0, joint.length, 0]);
      positions[joint.name] = {
        origin: { x: frame.origin.x, y: frame.origin.y, z: frame.origin.z },
        tail: { x: frame.origin.x + moved[0], y: frame.origin.y + moved[1], z: frame.origin.z + moved[2] }
      };
    });
    return positions;
  }

  /* ---- 矩阵小工具:IK 需要"把世界空间里的旋转换算回关节欧拉角" ---- */

  function transpose(matrix) {
    return [
      matrix[0], matrix[3], matrix[6],
      matrix[1], matrix[4], matrix[7],
      matrix[2], matrix[5], matrix[8]
    ];
  }

  /* 绕任意单位轴转 angle 弧度的 3x3 矩阵(罗德里格斯公式,行主序) */
  function axisAngleMatrix(axis, angle) {
    var length = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    if (!(length > 1e-9)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var x = axis[0] / length, y = axis[1] / length, z = axis[2] / length;
    var c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c
    ];
  }

  /* rotationMatrix 的逆运算:从 R = Rz·Ry·Rx 里解回 x / y / z(度)。
     展开后 r20 = -sin y,所以 y = -asin(r20);余下两行分别给出 x 与 z。
     万向锁(y = ±90 度)时 cos y → 0,x 与 z 分不开,此时把整圈让给 z。 */
  function eulerFromMatrix(matrix) {
    var m = matrix;
    var sy = Math.max(-1, Math.min(1, -m[6]));
    var y = Math.asin(sy);
    var cy = Math.cos(y);
    var x;
    var z;
    if (Math.abs(cy) > 1e-6) {
      x = Math.atan2(m[7], m[8]);
      z = Math.atan2(m[3], m[0]);
    } else {
      x = 0;
      z = Math.atan2(-m[1], m[4]);
    }
    var degrees = 180 / Math.PI;
    return { x: x * degrees, y: y * degrees, z: z * degrees };
  }

  /* 姿态序列化格式;读写都经过 normalize,不认识的字段一律丢弃 */
  function serialize(pose) {
    var value = pose || {};
    return {
      schema: 1,
      name: String(value.name || ""),
      updatedAt: Number(value.updatedAt) || Date.now(),
      angles: normalize(value.angles)
    };
  }

  function parse(payload) {
    var value = typeof payload === "string" ? app.utils.parseJson(payload, null) : payload;
    if (!value || typeof value !== "object" || !value.angles) return null;
    return serialize(value);
  }

  app.rig = {
    joints: JOINTS,
    presets: PRESETS,
    limits: LIMITS,
    angleKeys: ANGLE_KEYS,
    height: RIG_HEIGHT,
    bbox: BBOX,
    applyModel: applyModel,
    model: model,
    byName: byName,
    names: names,
    isPaired: isPaired,
    isPivot: isPivot,
    isTrunk: isTrunk,
    isNode: isNode,
    grabMode: grabMode,
    boneGrab: boneGrab,
    clampJoint: clampJoint,
    jointRange: jointRange,
    relativeAngle: relativeAngle,
    absoluteAngle: absoluteAngle,
    ikChain: ikChain,
    mirrorName: mirrorName,
    defaultAngles: defaultAngles,
    normalize: normalize,
    applyPreset: applyPreset,
    mirror: mirror,
    rotationMatrix: rotationMatrix,
    localUp: localUp,
    frames: frames,
    jointPositions: jointPositions,
    matrixMultiply: multiply,
    matrixApply: apply,
    transpose: transpose,
    axisAngleMatrix: axisAngleMatrix,
    eulerFromMatrix: eulerFromMatrix,
    serialize: serialize,
    parse: parse
  };
})(window.posegi);
