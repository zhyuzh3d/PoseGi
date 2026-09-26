/* 3D 视口:场景、相机、人物模型、命中检测、拖拽、截图
 *
 * 责任:唯一接触 three.js 的模块。对外只暴露"放一个姿态进去、拿一张图出来"。
 *
 * 场景图(与 app/core/rig.js 的层级一一对应):
 *   scene → bbox(Group,人物子空间,可整体搬运) → broot → hips → spine / thigh.L / thigh.R → …
 *
 * 小人怎么画:
 *   零件 = 人物模型里离线切好的刚体件(app/core/models.js),每个关节一件。
 *          顶点本身写在关节局部坐标系里、尺寸也已经是米,所以挂上去既不缩放也不偏移。
 *   把手 = 关节上的一颗球,只在 rig 里标了 node 的关节上有。
 *          默认由本文件画在关节原点上 —— 它是**唯一由本文件决定尺寸的东西**
 *          (NODE_RADIUS):模型给的 radius 是零件包围球半径,不能当球半径用。
 *          标了 nodeFrom: "model" 的关节(肩)不另画:模型自带的那颗球就是把手,
 *          而它的球心就落在关节原点上(骨架按人体测量学校正过),所以命中锚点
 *          直接取原点,不需要任何偏移补偿。
 *          这条不变量由 tests/ik.test.mjs 守着(直接量球块质心)。
 *          球常显、也参与射线 —— 它就是"腕、踝这些关节"的可视把手,
 *          而零件网格自己抓的是"转角度"。
 *
 * 姿态数据到渲染的唯一桥梁是 applyPose():
 *   每个关节对象的局部矩阵直接由 app.rig.rotationMatrix() 拼出来,
 *   所以渲染结果与 rig.js 的前向运动学必然一致,不存在两套数学。
 *
 * 交互分层(与"锁定"模型一致):
 *   拖空白        → 绕**当前目标点**转相机(标准 OrbitControls 语义:看向哪 = 绕哪转)。
 *                    绕转不动目标,所以按下的一瞬间画面不会挪;目标只在"双指平移"
 *                    和"双击适配屏幕"时改(见 视图导航 一节)
 *   点空白        → 取消选择
 *   双指拖        → 平移相机(目标一起走)
 *   捏合          → 推近/拉远(改的是到目标的距离)
 *   双击空白      → 整个人回到画面正中、大小铺满舞台(viewport:reframe)
 *   拖连接杆      → 绕该关节旋转(屏幕空间最小二乘,手指按住的那个点跟手)
 *   拖节点        → IK 移动:把节点起点拉到手指所在的平面点上(app/core/ik.js)
 *   搬运模式      → 拖人 = 移动 bbox,整体平移,姿态一个字节都不改
 *   正反着色      → 把黑白当成一层表面着色,按 30% 混进模型原本的材质颜色。
 *                    只改 shader 输出,不碰姿态数据、不碰光照与场景(见 正反着色 一节)
 *
 * 事件(本模块不反向调用上层,由 app.js 装配):
 *   viewport:ready / unavailable / lost / restored
 *   viewport:picked  { joint, part }        part 是"拖动语义":bone=旋转,node=移动
 *   viewport:rotate  { joint, patch: {…} }  拖连接杆
 *   viewport:ik      { joint, angles: {关节名: {x,y,z}} }  拖节点
 *   viewport:body    { position: {x,y,z} }
 *   viewport:blank   {}                     点了一下空白(挂起 320ms 后才发)
 *   viewport:blank-pending {}               同一次点击,但立刻发:挂起开始
 *   viewport:blank-cancel  {}               挂起被撤掉(双击成立),别真清选择
 *   viewport:reframe {}                     空白处双击:该重新取景了
 *   viewport:camera  { active }             视图(相机)开始/结束被操作:
 *                                           单指在空白处真的拖起来、或有第二根手指落下时为 true;
 *                                           抬手还原。状态行据此改说相机那三件事。
 *
 * 约束:
 *   - 不使用 flex gap 之类的现代布局;尺寸由容器决定,ResizeObserver 不可用时退回 resize 事件。
 *   - WebGL 必须特性检测:拿不到上下文时给出可读提示并保持页面可用。
 *   - 必须处理 webglcontextlost / restored,否则回到前台黑屏。
 */
(function (app) {
  "use strict";

  var THREE = window.THREE;

  var HEAD_JOINT = "head";
  var BBOX_SIZE = { width: 0.86, height: 1.88, depth: 0.62, centerY: 0.94 };

  /* 关节把手(节点球)的基准半径,米。乘每个关节自己的 nodeScale。
     画出来的球**保持小**(基准 0.045,与之前那版看得见的球一个量级:肘 0.059、膝 0.059、
     腕 0.047),不随"好不好点"一起放大 —— 好点由下面那个屏幕容差负责。
     另外它也与零件的粗细脱钩:模型的 radius 是**包围球半径**(小腿 0.216、髋 0.24),
     直接拿来当球半径会得到比脑袋还大的球,整条腿都被它盖住,点空地就再也点不中。 */
  var NODE_RADIUS = 0.045;

  /* broot(纯变换节点)那颗八面体的半径,米。它是"整体搬运"的把手,不是人体的一部分,
     所以尺寸自由:取节点球的 2.2 倍(0.045 → 0.10,即旧值 0.05 的一倍),
     一眼就能在小人身上认出它来。放大不改变可见性规则 —— 仍然**只在它被选中时才现**,
     与节点球完全同一套规则(见 highlight),平时画面上不多任何东西。 */
  var PIVOT_RADIUS = 0.10;

  /* 命中容差 */
  /* 手指落在关节原点多少像素以内,优先判成"抓住这个关节"(移动 / IK)。
     这是**屏幕距离**,与镜头远近无关 —— 手指在屏幕上大概就是这么宽,所以放远的
     小人也能点得着,而放近时球在屏幕上变大、容差不会再跟着涨。
     曾经是 33(球画小之后靠它把"好点"的手感补回来),但那个圈太大:
     两个关节挨得近时(腕与肘、左右踝),想点骨杆中段会被邻近的节点抢走。
     2026-09-25 按用户要求收到 80%:33 → 26。 */
  var NODE_GRAB_PX = 26;
  /* 胖射线的判定半径(米)。这是"射线刚好擦过细零件"时的兜底 ——
     零件网格自己也在拾取表里,正常情况是精确命中,所以这里只给一个细窄的容差:
     给大了(上一版拿零件包围球半径 ×1.5,前臂算出 0.20)整条腿旁边的空地都算命中。 */
  var BONE_RADIUS = 0.030;

  /* 拖连接杆时单次移动最多转多少弧度,避免手指一动就把关节甩飞 */
  var TURN_LIMIT = 0.32;
  /* 力臂的下限(米)。小人在屏幕上只有一屏高(约 330 像素/米),而手指一拖就是
     上百像素:力臂比手指行程还小的时候,几何上根本转不到,解出来的角度会大得
     离谱,再被单步上限一夹就变成"甩飞"。按这个长度兜底,增益就有上限。
     取 0.20 而不是更小,是为了让短关节(肩 10cm、脖子 7cm)与四肢的手感一致:
     拖同样距离,转过的角度差不多,不会"抓肩一碰就飞、抓大腿纹丝不动"。 */
  var LEVER_MIN = 0.20;
  /* 一个通道每弧度在屏幕上走不满最强通道的这个比例,就当成"没反应"不参与解算 */
  var RESPONSE_SHARE = 0.55;
  /* 2x2 解算的可用下限:绝对下限(像素²/弧度²)与"两轴夹角"下限(≈17 度) */
  var SOLVE_MIN_DETERMINANT = 40;
  var SOLVE_MIN_ANGLE = 0.3;

  /* 空白处按下后位移不超过这么多像素,就当成"点了一下空白"而不是"拖了一把" */
  var TAP_SLOP = 8;
  /* 空白处连点两下 = 把整个人重新摆回画面正中。两次点击的时限与位移容差:
     手指点两下本来就有几像素漂移,给宽一点;时限比系统双击(约 300ms)略宽。 */
  var DOUBLE_TAP_MS = 320;
  var DOUBLE_TAP_PX = 36;

  /* 场景配色跟页面主题走:深色页面里放一块浅底视口会非常刺眼。
     小人本身是原木色,浅色主题下偏暖、深色主题下偏灰。
     env 是**环境三色**:贴在天空球内壁上的一条纵向渐变 —— 上天空、下地面,中间一条
     最亮的雾色当"虚地平线"。三个十六进制值就是**屏幕上会看到的字节值**
     (环境球由本文件自己的 shader 原样输出,见 环境 一节,真机采样已核对:写 0x8cc4ee
     量出来就是 (140,196,238)),所以按肉眼想要的颜色写即可,不需要反推 gamma。
     亮色那套:亮蓝天蓝 / 雾白 / 灰黄土。
     深色那套:同一调性压暗成深蓝 / 灰雾 / 暗土灰 —— 地平线仍是全图最亮的一条带,
     否则"雾化的地平线"在深色主题里会整条消失。
     (2026-09-25 试过一次"环境脱钩主题、一律白天配色",用户看过之后决定回到
      "深色主题配深色天空",所以这里仍然是每个主题各一套。)
     **当天稍后又定:应用不做主题切换,主题锁死深色(namespace.js 的 app.THEME),
     所以 light 这一套目前不可达,留着只为了让 setTheme 这个入口保持完整。** */
  var THEMES = {
    light: {
      env: { sky: 0x8cc4ee, horizon: 0xeef2f6, floor: 0xbdb1a0 },
      bone: 0xded1ba,
      node: 0xccbca1,
      head: 0xe5dbc6,
      pivot: 0x8590a0,
      select: 0x5b5bd6
    },
    dark: {
      env: { sky: 0x22303f, horizon: 0x46525f, floor: 0x2b2721 },
      bone: 0xa79d89,
      node: 0x91866f,
      head: 0xb5aa95,
      pivot: 0x94a1b2,
      select: 0x9a9af5
    }
  };
  /* 初值取锁值深色:视口在 setTheme 之前就会先建一遍场景,
     初值若还是 light,启动瞬间会闪一下亮色环境(2026-09-25 锁深色主题)。 */
  var themeName = "dark";

  var state = {
    container: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    bbox: null,
    boxHelper: null,
    environment: null,
    objects: {},
    parts: {},
    /* 当前造型:app/core/models.js 里的模型定义(骨架参数已由 rig.applyModel 装好) */
    figure: null,
    pickables: [],
    bones: [],
    raycaster: null,
    pointer: null,
    assets: null,
    angles: null,
    selected: "",
    selectedPart: "bone",
    mode: "pose",
    /* 正反着色:把黑白当成一层表面着色,按 30% 混进模型原本的材质颜色。
       判据**不是** gl_FrontFacing —— 人偶是闭合网格,从外面看每个可见三角形都是正面,
       按那个判据渲出来是一片白,一点信息都没有。理由与参数见 正反着色 一节。 */
    mask: null,
    /* 建几何时有多少件真的烘出了 aSide —— 自检据此发现"烘焙静默失效" */
    sided: 0,
    dragging: null,
    /* 当前按在屏幕上的手指(按下顺序无关,按 pointerId 记账)。
       双指手势只有在知道"一共有几根手指"时才敢判定,所以要自己记账。 */
    pointers: {},
    /* 关节拖拽期间把相机控件"冻结"掉,而不是靠 stopPropagation 吞事件(理由见 onPointerDown) */
    controlsFrozen: false,
    /* 视图导航的目标点(绕哪转、看向哪)就是 controls.target 本身,不再另存一份 ——
       两者曾经分开过(为了"绕某部件转但不把它摆到正中"),现在规则是统一的,见 视图导航 一节 */
    /* 空白处按下但还没抬起:用来区分"点一下"和"拖一把" */
    blankTap: null,
    /* 上一次点空白的时刻与位置:用来认"双击回正" */
    lastBlankTap: null,
    /* "点空白清选择"挂起的定时器:让双击的第一下不至于把选中清掉(见 onPointerUp) */
    blankTimer: null,
    /* 视图(相机)正在被操作吗 —— 状态行据此改口说相机那三件事(见 viewport:camera、
     * syncCameraActive)。判据只有两条:单指在空白处**真的拖起来了**(不是点一下),
     * 或者有两根手指按着(捏合 / 双指平移)。 */
    cameraActive: false,
    orbiting: false,
    available: false,
    reason: "",
    lost: false,
    frame: 0,
    observer: null,
    disposed: false
  };

  /* 复用向量,拖拽时每帧都会算,不想每次新建 */
  var scratchA = new THREE.Vector3();
  var scratchB = new THREE.Vector3();
  var scratchC = new THREE.Vector3();
  var scratchMatrix = new THREE.Matrix4();
  var scratchQuaternion = new THREE.Quaternion();
  var upAxis = new THREE.Vector3(0, 1, 0);
  var twistAxis = new THREE.Vector3(0, 0, 1);

  function rad(degree) { return degree * Math.PI / 180; }

  function text(zh, en) { return app.i18n.text(zh, en); }

  function ready() { return state.available && !state.lost && state.renderer && state.assets; }

  /* ---------- 特性检测 ---------- */

  function detect() {
    try {
      var probe = document.createElement("canvas");
      var context = probe.getContext("webgl") || probe.getContext("experimental-webgl");
      if (!context) return { available: false, reason: text("这台设备的 WebView 没有可用的 WebGL,3D 视口无法显示", "This WebView has no usable WebGL, so the 3D viewport cannot render") };
      return { available: true, reason: "" };
    } catch (error) {
      return { available: false, reason: text("WebGL 初始化失败:", "WebGL failed to start: ") + app.utils.cleanError(error) };
    }
  }

  /* ---------- 资源:几何体与材质 ---------- */

  function buildAssets() {
    var palette = THEMES[themeName];

    /* 场景里只剩这几件几何与人物造型无关(把手球、源点标记、包围盒框)。
       人物自己的零件几何一律来自模型,由 app/core/models.js 缓存并释放,不在这里建。
       地面圆盘、网格辅助线与脚下的软阴影都已经去掉:环境整个交给天空球,
       既然没有实体地面,就不该有落在"地面"上的影子(见 buildScene)。 */
    state.assets = {
      geometries: {
        node: new THREE.SphereGeometry(1, 16, 12),
        pivot: THREE.OctahedronGeometry ? new THREE.OctahedronGeometry(1, 0) : new THREE.SphereGeometry(1, 8, 6),
        box: new THREE.EdgesGeometry(new THREE.BoxGeometry(BBOX_SIZE.width, BBOX_SIZE.height, BBOX_SIZE.depth))
      },
      materials: {
        bone: new THREE.MeshStandardMaterial({ color: palette.bone, roughness: 0.68, metalness: 0.02 }),
        node: new THREE.MeshStandardMaterial({ color: palette.node, roughness: 0.72, metalness: 0.02 }),
        head: new THREE.MeshStandardMaterial({ color: palette.head, roughness: 0.62, metalness: 0.02 }),
        pivot: new THREE.MeshStandardMaterial({ color: palette.pivot, roughness: 0.5, metalness: 0.1 }),
        selected: new THREE.MeshStandardMaterial({ color: palette.select, roughness: 0.45, metalness: 0.08 }),
        box: new THREE.LineBasicMaterial({ color: palette.select, transparent: true, opacity: 0.55 })
      }
    };

    /* 正反着色挂在这三处零件材质上:bone(常态)、head(头/手/脚这类整块就是零件的关节)、
       selected(选中高亮)。开关只是 uniform,所以一切照旧,不开关的时候渲染结果一个字节都不变。 */
    ensureMask().attached = 0;
    ["bone", "head", "selected"].forEach(function (key) {
      if (attachMask(state.assets.materials[key], state.mask)) state.mask.attached += 1;
    });

    return state.assets;
  }

  /* ---------- 正反着色(shader 遮罩) ----------
   *
   * 用途:让"哪一半是正面"变成肉眼可见的事实,不必再靠推理 —— 第十轮的朝向结论
   * (面朝 +Z,左 = +X,见 docs/design-3d-scene.md 5.2)本来就该交给眼睛复核一次。
   *
   * **它是"着色",不是"整块替换"**(2026-09-25 用户定调):把黑白当成一层表面着色
   * **按 30% 混进模型原本的材质颜色里** —— 模型自己的明暗、体积感、主题配色全都留着,
   * 只在前、后两半上各叠一层白/灰的倾向。用户原话:「把黑白 shader 直接作为模型的
   * 表面着色使用,30% 透明度混合默认白模材质表面色」。
   * 因此这里**不动光照、不动主题、也不动场景里的地面与网格** ——
   * 早先那版是整块替换(纯白/纯灰),白到看不见人形,才需要压深背景把装饰收掉;
   * 换过着色方式之后那套就不再需要了。
   *
   * 判据**不是** gl_FrontFacing:人偶是闭合网格,从外面看每一个可见三角形都是正面,
   * 按那个判据渲出来是一片白,没有任何信息量。真正要区分的是**模型自身的前后**:
   *   世界法线 · 角色朝向 >= 0 → 叠白,否则叠灰。
   *
   * 实现要点(坑都在这里):
   *   - 全身零件**共用同一个材质**(materials.bone),所以补一次就盖住整个人。
   *   - 顶点在 <defaultnormal_vertex> 之后取 objectNormal(关节局部)乘 modelMatrix
   *     得到世界法线。**不能直接用 vNormal** —— 那是观察空间的,跟着相机转,
   *     "身体的前后"就没了意义。
   *   - 片元的混合点在 <encodings_fragment> **之后**:本机 vendor 是 r147,
   *     这个 chunk 还叫 encodings(colorspace 是 r152 才改的名)。放在编码之后,
   *     参与混合的两个值就都是**屏幕值** —— 白写 1.0,灰要写 0.5019 才是 #808080
   *     (写 0.5 出来不是 128);而且"按 30% 混"与合成软件里的 30% 叠加是同一个算法。
   *     写在编码之前会被 sRGB 抬亮到约 #bbb(与"深色主题别照背景色填"同源的坑)。
   *   - 用 uniform 开关而不是换材质:光照、主题配色、程序都不动,随手开关。
   *
   * 两个锚点是**字符串匹配**,three.js 一改名就会静默失效(replace 找不到就原样返回,
   * 不报错、照样编译通过,只是颜色一点没变)。所以自检里有一条 checkFaceMask 守着它们。 */
  var MASK_BACK_GRAY = 0.5019;
  /* 正反层混进材质颜色的比例(用户指定 30%)。0 = 完全不生效,1 = 整块替换。 */
  var MASK_MIX = 0.3;
  /* 三个档位,由底部 dock 的"正反"按钮循环切换:0 = 不显示,1 = 白/灰,2 = 红/绿。
     同一时刻只有一组颜色生效,所以 shader 里仍然只要两个颜色 uniform ——
     换档只是给它们重新赋值,既不重编程序、也不碰几何与姿态。 */
  var MASK_LAYERS = [
    null,
    { front: [1, 1, 1], back: [MASK_BACK_GRAY, MASK_BACK_GRAY, MASK_BACK_GRAY] },
    { front: [0.86, 0.14, 0.16], back: [0.10, 0.60, 0.22] }
  ];

  /* 正反着色只有三个量:开关、混色比例、两种颜色。
     判定依据**不在 uniform 里** —— 每个顶点"朝前多少"已经烘进几何的 aSide 属性
     (见 app/core/models.js 的 bakeSide),所以这里没有任何需要逐帧同步的方向量。 */
  function buildMaskUniforms() {
    var layer = MASK_LAYERS[1];
    return {
      uMaskOn: { value: 0 },
      uMaskMix: { value: MASK_MIX },
      uMaskFront: { value: new THREE.Vector3(layer.front[0], layer.front[1], layer.front[2]) },
      uMaskBack: { value: new THREE.Vector3(layer.back[0], layer.back[1], layer.back[2]) }
    };
  }

  /* 懒建(材质挂载与开关都会用到,不能各写一份,否则档位字段会漏) */
  function ensureMask() {
    if (!state.mask) {
      state.mask = { uniforms: buildMaskUniforms(), attached: 0, vertex: "", fragment: "", mode: 0 };
    }
    return state.mask;
  }

  /* 给一个材质挂上正反着色。三次调用用的是**同一个函数体** ——
     材质拿 onBeforeCompile.toString() 当程序缓存键,函数体一样才会共用同一个程序。 */
  function attachMask(material, mask) {
    if (!material || material.__maskBound) return false;
    material.__maskBound = true;
    var uniforms = mask.uniforms;
    material.onBeforeCompile = function (shader) {
      shader.uniforms.uMaskOn = uniforms.uMaskOn;
      shader.uniforms.uMaskMix = uniforms.uMaskMix;
      shader.uniforms.uMaskFront = uniforms.uMaskFront;
      shader.uniforms.uMaskBack = uniforms.uMaskBack;
      /* 判定量是几何自带的 aSide —— 每个顶点在**静止姿态**下朝前的程度:
         正数 = 正面色,负数 = 反面色。它只跟几何有关,与姿态、与相机都无关,
         所以这里既不需要世界矩阵,也没有任何要逐帧同步的方向量 —— 像一张贴图。
         (从前传的是"世界法线 + 一个角色朝向 uniform":世界法线跟着关节转、
          角色朝向不跟着关节转,于是**一转动关节,颜色就在零件表面流动**。) */
      shader.vertexShader = "attribute float aSide;\nvarying float vSide;\n" + shader.vertexShader.replace(
        "#include <defaultnormal_vertex>",
        "#include <defaultnormal_vertex>\n\tvSide = aSide;"
      );
      shader.fragmentShader = "varying float vSide;\n"
        + "uniform float uMaskOn;\nuniform float uMaskMix;\nuniform vec3 uMaskFront;\nuniform vec3 uMaskBack;\n"
        + shader.fragmentShader.replace(
          "#include <encodings_fragment>",
          "#include <encodings_fragment>\n"
          + "\tif ( uMaskOn > 0.5 ) {\n"
          + "\t\tvec3 maskColor = mix( uMaskBack, uMaskFront, step( 0.0, vSide ) );\n"
          + "\t\tgl_FragColor.rgb = mix( gl_FragColor.rgb, maskColor, uMaskMix );\n"
          + "\t}"
        );
      /* 留一份编译进程序的源码:自检据此判断"注入到底落上了没有"。
         replace 打空锚点时这里就不会有我们的那行 —— 这是唯一能发现它静默失效的办法。 */
      mask.vertex = shader.vertexShader;
      mask.fragment = shader.fragmentShader;
    };
    material.needsUpdate = true;
    return true;
  }

  /* 这里原来是 syncMaskDirection():每帧从 hips 的世界矩阵里取"角色朝向"喂给 shader。
     现在整块不需要了 —— 判定量是几何自带的 aSide(建几何时按静止姿态烘好,
     见 buildRig 与 app/core/models.js 的 bakeSide),它只跟几何有关。
     少一个逐帧同步点,也就少一类错法:从前"世界法线跟着关节转、角色朝向不跟",
     于是**转动任何单个关节,那个零件表面的颜色就会流动**(抬手臂就换面)。
     烘成顶点属性之后,颜色与姿态彻底解耦 —— 无论转关节、转整体、绕视角,都不再动。 */

  /* mode: 0 = 不显示,1 = 白/灰,2 = 红/绿。返回实际生效的档位。 */
  function setFrontBackMask(mode) {
    var next = (mode === 1 || mode === 2) ? mode : 0;
    var mask = ensureMask();
    mask.mode = next;
    mask.uniforms.uMaskOn.value = next > 0 ? 1 : 0;
    var layer = MASK_LAYERS[next];
    if (layer) {
      mask.uniforms.uMaskFront.value.set(layer.front[0], layer.front[1], layer.front[2]);
      mask.uniforms.uMaskBack.value.set(layer.back[0], layer.back[1], layer.back[2]);
    }
    /* 开关与配色都是 uniform,不是不同的 #define,所以**不需要**重编程序。
       也**不碰场景**(背景、地面、网格、影子一律保持原样):正反层只混 30%,
       模型自己的明暗、体积感、主题配色都还在,早先那套"压深背景 + 收掉地面"
       是为整块替换(纯白/纯灰)服务的,现在不成立了。 */
    return next;
  }

  /* 当前档位(0 / 1 / 2)—— dock 按钮据此循环到下一档 */
  function maskMode() {
    return state.mask ? state.mask.mode : 0;
  }

  function frontBackMask() {
    return maskMode() > 0;
  }

  /* 诊断出口:给自检与设备端页面状态用 */
  function maskInfo() {
    if (!state.mask) return null;
    return {
      on: frontBackMask(),
      /* 档位 0 = 不显示、1 = 白/灰、2 = 红/绿 */
      mode: state.mask.mode,
      attached: state.mask.attached,
      sided: state.sided,
      compiled: state.mask.fragment.length > 0,
      vertex: state.mask.vertex,
      fragment: state.mask.fragment,
      /* axis 是"正面"的基准轴,在**骨架空间**里恒为 +Z —— 它是常量,不是某个实时的
         世界方向(判定值烘在几何的 aSide 上),报出来只是让自检确认基准没被改坏。 */
      axis: [0, 0, 1],
      mix: state.mask.uniforms.uMaskMix.value
    };
  }

  /* 换主题只改颜色,不重建骨架。环境球也**不重建** —— 它的三个颜色是 uniform,
     就地写进去就行(早期版本把渐变画在纹理上,颜色换不了只能重画一张再换上去)。 */
  function paintTheme() {
    if (!state.assets) return;
    var palette = THEMES[themeName] || THEMES.light;
    var materials = state.assets.materials;
    materials.bone.color.setHex(palette.bone);
    materials.node.color.setHex(palette.node);
    materials.head.color.setHex(palette.head);
    materials.pivot.color.setHex(palette.pivot);
    materials.selected.color.setHex(palette.select);
    materials.box.color.setHex(palette.select);

    if (state.renderer) state.renderer.setClearColor(palette.env.sky, 1);
    if (state.scene && state.scene.background && state.scene.background.setHex) {
      state.scene.background.setHex(palette.env.sky);
    }

    if (state.scene) {
      if (state.environment) {
        applyEnvironment(state.environment, palette);
      } else {
        state.environment = buildEnvironment(palette);
        state.scene.add(state.environment);
      }
    }
    highlight(state.selected, state.selectedPart);
  }

  function disposeAssets() {
    if (!state.assets) return;
    var geometries = state.assets.geometries;
    ["node", "pivot", "box"].forEach(function (key) {
      if (geometries[key] && geometries[key].dispose) geometries[key].dispose();
    });
    ["bone", "node", "head", "pivot", "selected", "box"].forEach(function (key) {
      var material = state.assets.materials[key];
      if (material && material.dispose) material.dispose();
    });
    state.assets = null;
  }

  /* ---------- 环境:渐变天空球 ----------
   *
   * 用一个大球的内壁当背景,替掉原来的"纯色背景 + 实体地面圆盘 + 网格辅助线":
   * 没有硬边、也没有一块可见的地面平面,人物像站在一片雾里。
   * 球的赤道就是地平线,而地平线整条由 shader 里那条雾带表现,所以它是"虚"的。
   *
   * **颜色原样输出**:这是本模块唯一一处不走 three 内置材质的着色 —— 目的就是让
   * THEMES.env 里的十六进制值与屏幕像素一一对应。内置材质那条链把颜色当线性值、
   * 光照完再 linearToOutputTexel 编回 sRGB,中间调被抬亮,期望值与屏幕值对不上
   * (上一版把渐变画进 CanvasTexture,写 #eef2f6 量出来是 143,试了两轮都没收敛)。
   * 自己写 gl_FragColor 就直接落进帧缓冲,没有中间商,一次就能调准。
   * 因此片元里**不能**写 #include <encodings_fragment>,那等于又绕回那条编码链。
   */
  var ENV_RADIUS = 48;      // 相机远平面是 80,48 够"远",又不会被裁掉

  /* 顶点:把"球面上的高度"传给片元。用 normalize(position).y 而不是 atan 出来的仰角 ——
     它就是 sin(仰角),靠近地平线处变化更"挤",雾带因此天然更宽。
     0 = 地平线,+1 = 天顶,-1 = 脚下。 */
  var ENV_VERTEX_SHADER = [
    "varying float vHeight;",
    "void main() {",
    "  vHeight = normalize( position ).y;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );",
    "}"
  ].join("\n");

  /* 片元:三段纯色在地平线两端各自 smoothstep 过渡。
     0.012 是地平线附近那条"雾心"(完全不混色的一小条),0.24 / 0.26 决定雾带多宽 ——
     约 14 度仰角就走到纯天空色,而默认机位竖直视野只有 40 度,这个宽度正好让画面上缘
     是蓝天、脚下是土黄、中间一条白雾横贯。h 过 0 时两个 mix 都等于 uHorizon,
     所以这条 step 阶梯不产生接缝。 */
  var ENV_FRAGMENT_SHADER = [
    "uniform vec3 uSky;",
    "uniform vec3 uHorizon;",
    "uniform vec3 uFloor;",
    "varying float vHeight;",
    "void main() {",
    "  float h = clamp( vHeight, -1.0, 1.0 );",
    "  vec3 above = mix( uHorizon, uSky, smoothstep( 0.012, 0.240, h ) );",
    "  vec3 below = mix( uHorizon, uFloor, smoothstep( 0.012, 0.260, -h ) );",
    "  gl_FragColor = vec4( mix( below, above, step( 0.0, h ) ), 1.0 );",
    "}"
  ].join("\n");

  /* 十六进制 → 0..1 三元组,**不做任何色彩空间转换**:这三个数会被原样写进帧缓冲,
     它们就是屏幕上出现的字节值。故意绕开 THREE.Color —— 它在 legacyMode 下虽然也不转换,
     但那取决于 three 的全局开关,而这里"期望值 = 屏幕值"是硬要求。 */
  function envColor(hex) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  /* 换主题时就地改写三个 uniform,不重建几何与材质 */
  function applyEnvironment(mesh, palette) {
    var uniforms = mesh && mesh.material && mesh.material.uniforms;
    if (!uniforms) return false;
    var keys = [["uSky", palette.env.sky], ["uHorizon", palette.env.horizon], ["uFloor", palette.env.floor]];
    for (var i = 0; i < keys.length; i++) {
      var rgb = envColor(keys[i][1]);
      var value = uniforms[keys[i][0]].value;
      value[0] = rgb[0];
      value[1] = rgb[1];
      value[2] = rgb[2];
    }
    return true;
  }

  function buildEnvironment(palette) {
    var material = new THREE.ShaderMaterial({
      uniforms: {
        uSky: { value: envColor(palette.env.sky) },
        uHorizon: { value: envColor(palette.env.horizon) },
        uFloor: { value: envColor(palette.env.floor) }
      },
      vertexShader: ENV_VERTEX_SHADER,
      fragmentShader: ENV_FRAGMENT_SHADER,
      side: THREE.BackSide,     // 从球里面看
      depthWrite: false,        // 它只是背景,不参与深度
      fog: false
    });
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(ENV_RADIUS, 32, 24), material);
    /* 先画:renderOrder 最小 + 不写深度 ⇒ 永远垫在最底下,不吃场景里的任何东西 */
    mesh.renderOrder = -1;
    /* 相机始终在球内,包围球永远与视锥相交,剔不剔都一样;显式关掉是防"哪天相机拉远了整块消失" */
    mesh.frustumCulled = false;
    return mesh;
  }

  function disposeEnvironment() {
    if (!state.environment) return;
    if (state.environment.material) state.environment.material.dispose();
    if (state.environment.geometry) state.environment.geometry.dispose();
    state.environment = null;
  }

  /* ---------- 场景与骨架 ---------- */

  function buildScene() {
    var palette = THEMES[themeName];
    var scene = new THREE.Scene();
    /* 背景色只当兜底(天空球盖不住的那几个像素);真正的天空由天空球铺满 */
    scene.background = new THREE.Color(palette.env.sky);
    state.scene = scene;

    var width = Math.max(1, state.container.clientWidth);
    var height = Math.max(1, state.container.clientHeight);
    var camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 80);
    camera.position.set(0.52, 1.22, 2.75);
    camera.lookAt(0, 0.9, 0);
    state.camera = camera;

    /* 加起来别太亮:没有色调映射,过曝会把锥度与球关节的明暗分界一起冲掉,
       小人在浅色主题下就糊成一团白。本机渲染调过一次。 */
    scene.add(new THREE.HemisphereLight(0xffffff, 0x93a0ad, 0.55));
    var key = new THREE.DirectionalLight(0xffffff, 0.78);
    key.position.set(1.5, 2.8, 2.2);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xdbe6f2, 0.22);
    fill.position.set(-2.2, 1.5, -1.6);
    scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.18);
    rim.position.set(-0.6, 1.2, -2.6);
    scene.add(rim);

    /* 环境:渐变天空球。地面圆盘、网格辅助线与脚下的影子都是在这里被替掉的 ——
       没有可见的地面平面,地平线由 shader 里那条雾带表现,人物像站在一片雾里。
       影子一并去掉(2026-09-25 用户定调):既然没有实体地面,那块贴在 y≈0 上的
       半透明暗斑就成了悬在半空的一块灰饼,反而更假。 */
    var environment = buildEnvironment(palette);
    scene.add(environment);
    state.environment = environment;

    /* bbox:人物所在的子空间。"搬运"移动的就是它,姿态不受影响。 */
    var bbox = new THREE.Group();
    scene.add(bbox);
    state.bbox = bbox;

    var helper = new THREE.LineSegments(state.assets.geometries.box, state.assets.materials.box);
    helper.position.y = BBOX_SIZE.centerY;
    helper.visible = false;
    bbox.add(helper);
    state.boxHelper = helper;

    return scene;
  }

  /* 当前造型的几何定义。
   *
   * 骨架对象树本身是**固定**的(rig.js 的关节表),每个关节挂什么网格由这里决定:
   *   有定义 → 模型里那一件刚体零件(顶点已写在关节局部坐标系里,尺寸已是米)
   *   没定义 → 挂一个空的 Object3D:骨架与数学照常工作,只是这个关节什么都不画
   *            (配置里存着已删除的模型、或模型脚本没加载成功时走这条路)。
   * 于是 FK、命中检测、高亮、取景与 IK 一行都不用改 —— 它们量的都是关节原点与骨长。
   * 骨架参数本身由 app/features/figure.js 在启动/切换时写进 app.rig。 */
  function figureDefinition() {
    var definition = app.rig.model();
    if (!definition || !definition.parts) return null;
    if (!app.models || !app.models.geometry) return null;
    return definition;
  }

  function buildRig() {
    state.objects = {};
    state.parts = {};
    state.pickables = [];
    state.sided = 0;
    state.figure = figureDefinition();
    var figure = state.figure;
    /* 正反着色要"以当前站姿为基准、定下来就不再变",所以这里先算出整棵骨架在
       **静止姿态**下的朝向,建每个零件的几何时按关节取用(见 models.geometry 的 basis)。
       用 rig 的纯数学算,不去读场景里的 matrixWorld —— 几何必须先在骨架摆好之前建出来。
       rest 已经含 twist(把掌心拧到朝前的那一次),所以基准正是"现在这个站姿"。 */
    var restFrames = app.rig.frames(app.rig.defaultAngles());

    app.rig.joints.forEach(function (joint) {
      var object = new THREE.Object3D();
      object.name = "joint:" + joint.name;
      object.matrixAutoUpdate = false;
      var parent = joint.parent ? state.objects[joint.parent] : null;
      (parent || state.bbox).add(object);
      state.objects[joint.name] = object;

      var parts = { bone: null, node: null };

      if (joint.pivot) {
        /* 纯变换节点:画个八面体当把手。它和别的把手一样**选中才现**(见 highlight)——
           "只在选中时出现"是硬规则,不因为把它放大就变成常显:放大只是让它更醒目。
           拖它等于"整体搬运 bbox"(见 onPointerDown 里的 kind = "body" 分支)——
           broot 自己既不旋转也不移动,它只是骨架顶层;人物的整体旋转是 hips 的事
           (转 hips 会带动脊柱与双腿,等于绕骨盆转一圈)。 */
        var marker = new THREE.Mesh(state.assets.geometries.pivot, state.assets.materials.pivot);
        marker.scale.setScalar(PIVOT_RADIUS);
        marker.visible = false;
        marker.userData.joint = joint.name;
        marker.userData.part = "node";
        object.add(marker);
        parts.node = marker;
        state.pickables.push(marker);
        state.parts[joint.name] = parts;
        return;
      }

      /* 零件几何来自人物模型:顶点已经写在关节局部坐标系里、尺寸也已经是米,
         所以既不缩放也不偏移 —— scale 与 position 保持单位值,直接挂上去。
         材质一律给 materials.bone:**该不该换另一副材料**(头、手、脚这类"整块就是零件"
         的关节)由 highlight 按选中态决定,与"拖动算旋转还是移动"是两套判定 ——
         两者曾经共用同一个判定,于是"改交互"顺手把配色也改掉。
         这里原来还留着一份 isJointLook/material 的计算结果,算完从没被用过,已删。 */
      var rest = restFrames[joint.name];
      var geometry = app.models.geometry(figure.id, joint.name, rest && rest.orientation);
      if (geometry && geometry.getAttribute("aSide")) state.sided += 1;
      var bone = geometry
        ? new THREE.Mesh(geometry, state.assets.materials.bone)
        : new THREE.Object3D();
      /* part 记的是"这一件是什么网格":零件就是零件、球就是球。
         拖动到底算旋转还是移动,另外由 rig.boneGrab(零件) / rig.grabMode(球)判定。
         这里是"小臂、小腿选不中"的现场:零件网格曾经被标成 node,
         于是点小臂中间等于去拽肘球,零件自己既转不动、高亮也落在小球上。 */
      bone.userData.joint = joint.name;
      bone.userData.part = "bone";
      object.add(bone);
      parts.bone = bone;
      /* 拾取表里只放真正有几何的那一件:空对象不参与射线,免得点哪儿都命中 */
      if (geometry) state.pickables.push(bone);

      /* 把手球:大多数关节由本文件画一颗,球心就在关节原点上。
         标了 nodeFrom: "model" 的关节(肩)不画 —— 模型那一节自带的球就是把手。
         理由是量出来的:我们画的球(R 0.0531)比模型肩球(R 0.0550)还小,再画一颗
         就会在肩上叠成两颗互相穿插的球。所以肩上留下的就是模型那颗球,而它的球心
         与关节原点是同一个点(骨架校正过),命中锚点直接取原点即可。 */
      if (joint.node && joint.nodeFrom !== "model") {
        var node = new THREE.Mesh(state.assets.geometries.node, state.assets.materials.node);
        /* 球的尺寸与模型、与关节都无关:它是"操作把手",不是零件的一部分。
           用模型给的 radius 当球半径是不行的 —— 那是**零件的包围球半径**(约等于零件
           全长的一半),小腿有 0.216、髋 0.24;照它画出来的球比脑袋还大,
           而且腿上每一根都摊到一大片,点空地就再也点不到了(本机踩过)。
           各关节自己再乘 nodeScale 放大过一轮,那批差异已删:球现在是"选中才现"的
           提示,不靠尺寸区分谁大谁小;能不能点中由 NODE_GRAB_PX(屏幕像素)负责,
           与球的大小没有关系。 */
        node.scale.setScalar(NODE_RADIUS);
        /* 球一律画在关节原点上,不摆位:把手球心与关节原点必须是同一个点
           (模型自带的那颗也照此校正过),所以这里没有任何偏移量可用。 */
        node.userData.joint = joint.name;
        node.userData.part = "node";
        /* 默认藏着,选中这个关节才显示(见 highlight)。
           它留在拾取表里,于是射线也给它一次机会 —— 看不见,但点得中。 */
        node.visible = false;
        object.add(node);
        parts.node = node;
        state.pickables.push(node);
      }

      state.parts[joint.name] = parts;
    });

    state.bbox.updateMatrixWorld(true);
  }

  /* ---------- 姿态 ---------- */

  /* 换人物造型:骨架参数已由 app/features/figure.js 写进 app.rig,这里只把
     "挂在骨架上"的那一层重新搭一遍 —— 灯具、地面、网格、相机与轨道控件全部保留。
     刻意不走整场 rebuild():那条路会把相机与 controls 一起丢掉。
     调用方传入该造型的默认姿态(两套骨架的 rest 完全不同,不能沿用旧的)。 */
  function setFigure(angles) {
    if (!state.bbox || !state.assets) return false;
    /* 先把旧的关节对象整棵摘掉 —— buildRig 会建同名的新的,
       不摘的话两份重名节点会叠在一起,拾取与高亮都会指错。 */
    app.rig.joints.forEach(function (joint) {
      var object = state.objects[joint.name];
      if (object && object.parent) object.parent.remove(object);
    });
    buildRig();
    applyPose(angles || app.rig.defaultAngles());
    highlight(state.selected, state.selectedPart);
    return true;
  }

  function applyPose(angles) {
    var pose = app.rig.normalize(angles);
    state.angles = pose;
    if (!state.assets) return pose;

    app.rig.joints.forEach(function (joint) {
      var object = state.objects[joint.name];
      if (!object) return;
      var r = app.rig.rotationMatrix(pose[joint.name]);
      object.matrix.set(
        r[0], r[1], r[2], joint.offset[0],
        r[3], r[4], r[5], joint.offset[1],
        r[6], r[7], r[8], joint.offset[2],
        0, 0, 0, 1
      );
    });
    state.bbox.updateMatrixWorld(true);
    refreshBones();
    return pose;
  }

  /* 骨杆的世界线段:胖射线命中检测要用,步骤固定,顺手算一次省得每次拾取都遍历对象树 */
  function refreshBones() {
    var list = [];
    app.rig.joints.forEach(function (joint) {
      if (joint.pivot) return;
      var object = state.objects[joint.name];
      if (!object) return;
      list.push({
        name: joint.name,
        origin: object.localToWorld(new THREE.Vector3(0, 0, 0)),
        tail: object.localToWorld(new THREE.Vector3(0, joint.length, 0)),
        radius: Math.max(0.02, BONE_RADIUS)
      });
    });
    state.bones = list;
  }

  /* 选中态的两个视觉出口:零件网格换材质、把手球现形。
   *
   * 把手球(parts.node)平时是**藏着的**,只有被选中的那个关节才显示出来 ——
   * 它是"操作提示",不是人物造型的一部分:常显会盖住模型自带的关节球
   * (肩那颗还偏心 4.7cm,叠出来就是两颗错位的球),也让画面上到处是球,
   * 分不清哪块是人体、哪块是控件。
   * 不可见不等于点不中:命中靠 nearestNode 的屏幕容差(NODE_GRAB_PX),
   * 球留在拾取表里只是顺带多给一点可点面积(three 的射线不看 visible)。
   *
   * 谁把 state.selected 改掉:viewport:picked(点中关节)、viewport:blank(点空地),
   * 以及上层的 setSelectedJoint。**相机操作一个都不在这里** —— 拖空白、双指缩放、
   * 双击回正都不会碰 state.selected(见 onPointerMove / onPointerUp 里的 blankTap)。 */
  function highlight(name, part) {
    state.selected = app.rig.byName(name) ? String(name) : "";
    state.selectedPart = part === "node" ? "node" : "bone";
    if (!state.assets) return;
    app.rig.joints.forEach(function (joint) {
      var parts = state.parts[joint.name];
      if (!parts) return;
      var on = joint.name === state.selected;
      /* 高亮照着"这一件是谁"来:选中杆就亮杆。
         另外,整块就是零件本身的关节(头、手、脚)没有独立可看的杆,
         选中它们的节点时把零件一起点亮 —— 头连球都没有,
         只按"点杆才亮杆"的规则走,头被选中时屏幕上一点变化都没有。 */
      var boneOn = on && (state.selectedPart === "bone" || app.rig.boneGrab(joint.name) === "node");
      if (parts.bone) {
        var boneBase = joint.name === HEAD_JOINT || app.rig.grabMode(joint.name) === "node"
          ? state.assets.materials.head
          : state.assets.materials.bone;
        parts.bone.material = boneOn ? state.assets.materials.selected : boneBase;
      }
      if (parts.node) {
        /* 把手球只在"这个关节就是当前选中"时现身 —— broot 那颗八面体走同一条规则:
           它放大到 2 倍之后**仍然不该常显**,否则画面上会一直挂着一颗蓝色八面体。 */
        parts.node.visible = on;
        var nodeBase = joint.pivot ? state.assets.materials.pivot : state.assets.materials.node;
        parts.node.material = on ? state.assets.materials.selected : nodeBase;
      }
    });
  }

  /* ---------- 屏幕空间辅助 ---------- */

  function toScreen(vector) {
    scratchA.copy(vector).project(state.camera);
    return {
      x: (scratchA.x * 0.5 + 0.5) * state.canvas.clientWidth,
      y: (-scratchA.y * 0.5 + 0.5) * state.canvas.clientHeight
    };
  }

  /* 世界方向在屏幕上的走向:沿 direction 走 probe 米,屏幕上挪了多少像素。
     返回值除以 probe 就是"每米多少像素",乘上 m/rad 的位移速度即得"每弧度多少像素"。 */
  function screenDirection(origin, direction) {
    var probe = 0.05;
    var from = toScreen(origin);
    var to = toScreen(scratchC.copy(origin).addScaledVector(direction, probe));
    return {
      x: (to.x - from.x) / probe,
      y: (to.y - from.y) / probe
    };
  }

  function jointWorldPosition(name, out) {
    var object = state.objects[name];
    if (!object) return null;
    var target = out || new THREE.Vector3();
    return object.getWorldPosition(target);
  }

  /* 某个欧拉通道的转轴,方向在世界空间。
     局部旋转矩阵 R = Rz·Ry·Rx,于是
       ∂R/∂x 的转轴是 Rz·Ry·e_x,∂R/∂y 的是 Rz·e_y,∂R/∂z 的就是 e_z(都在父坐标系里)。 */
  function channelAxisWorld(name, key) {
    var angle = state.angles[name] || { x: 0, y: 0, z: 0 };
    var object = state.objects[name];
    var axis = new THREE.Vector3();
    if (key === "x") {
      axis.set(1, 0, 0).applyQuaternion(
        scratchQuaternion.identity().setFromAxisAngle(twistAxis, rad(angle.z))
          .multiply(new THREE.Quaternion().setFromAxisAngle(upAxis, rad(angle.y)))
      );
    } else if (key === "y") {
      axis.set(0, 1, 0).applyQuaternion(
        scratchQuaternion.identity().setFromAxisAngle(twistAxis, rad(angle.z))
      );
    } else {
      axis.set(0, 0, 1);
    }
    if (object && object.parent) {
      scratchQuaternion.setFromRotationMatrix(object.parent.matrixWorld);
      axis.applyQuaternion(scratchQuaternion);
    }
    return axis.normalize();
  }

  function cameraForward(out) {
    var target = out || new THREE.Vector3();
    if (state.camera.getWorldDirection) return state.camera.getWorldDirection(target);
    target.subVectors(state.controls ? state.controls.target : new THREE.Vector3(), state.camera.position).normalize();
    return target;
  }

  function updatePointer(clientX, clientY) {
    var rect = state.canvas.getBoundingClientRect();
    var width = Math.max(1, rect.width);
    var height = Math.max(1, rect.height);
    state.pointer.x = ((clientX - rect.left) / width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return { left: rect.left, top: rect.top, width: width, height: height };
  }

  /* ---------- 命中检测 ---------- */

  function blankHit() { return { joint: "", part: "", point: null }; }

  /* 抓到某个关节之后走哪条路(旋转 / 移动)由 rig.grabMode 一家说了算,
     三个命中入口(节点距离、射线、胖射线)都问它,免得各说各话。 */

  /* 命中锚点就是**关节原点的世界位置**。这里曾经有一段偏移补偿:肩的把手球
     用模型自带的那颗,而那颗球的球心偏在关节原点外 4.7cm,所以命中区得跟到球心
     上去。骨架按人体测量学校正后球心已归零(实测球块质心 0.0mm),补偿删掉。 */

  /* 节点比骨杆小得多,所以先按屏幕距离给节点一次优先权:
     手指落在节点球附近就判"移动节点",落在骨杆中段才判"旋转"。这就是用户要的两分法。 */
  function nearestNode(x, y, limit) {
    var best = null;
    var bestDistance = limit;
    app.rig.joints.forEach(function (joint) {
      if (!joint.node) return;
      var object = state.objects[joint.name];
      if (!object) return;
      var screen = toScreen(object.getWorldPosition(scratchB));
      var distance = Math.sqrt((screen.x - x) * (screen.x - x) + (screen.y - y) * (screen.y - y));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          joint: joint.name,
          part: app.rig.grabMode(joint.name),
          point: object.getWorldPosition(new THREE.Vector3())
        };
      }
    });
    return best;
  }

  /* 胖射线:细射线打细骨杆经常擦过去,所以直接算"相机射线到骨杆线段"的最短距离,
     小于骨骼半径就算命中,取离相机最近的那一根。 */
  function fatRayBone() {
    var ray = state.raycaster.ray;
    var best = null;
    var bestDepth = Infinity;
    state.bones.forEach(function (entry) {
      var distanceSq = ray.distanceSqToSegment(entry.origin, entry.tail, scratchA, scratchB);
      if (distanceSq > entry.radius * entry.radius) return;
      var depth = scratchA.distanceTo(ray.origin);
      if (depth < bestDepth) {
        bestDepth = depth;
        best = { joint: entry.name, point: scratchB.clone() };
      }
    });
    if (!best) return null;
    /* 胖射线量的是骨杆线段,所以走"杆"的语义 */
    return { joint: best.joint, part: app.rig.boneGrab(best.joint), point: best.point };
  }

  function pick(clientX, clientY) {
    if (!ready() || !state.canvas) return blankHit();
    var rect = updatePointer(clientX, clientY);

    /* 球优先:球比杆小得多,命中先给球一次机会,球内就是"移动节点" */
    var node = nearestNode(clientX - rect.left, clientY - rect.top, NODE_GRAB_PX);
    if (node) return node;

    var hints = state.raycaster.intersectObjects(state.pickables, false);
    if (hints.length) {
      var object = hints[0].object;
      if (object.userData.joint) {
        /* 命中哪一件网格就按哪一件的语义走:球→grabMode(移动),杆→boneGrab(旋转)。
           头是特例:它没画球,整块椭球就是零件本身,靠 grab: "node" 让"拖头=移头"。 */
        var piece = object.userData.part === "node" ? "node" : "bone";
        return {
          joint: object.userData.joint,
          part: piece === "node" ? app.rig.grabMode(object.userData.joint) : app.rig.boneGrab(object.userData.joint),
          point: hints[0].point.clone()
        };
      }
    }
    return fatRayBone() || blankHit();
  }

  /* ---------- 拖拽 ---------- */

  /* 旋转的力臂 = 骨骼自身(原点到末端)。
     不用"手指按住的那个点":细骨杆上能被判中的点离关节往往只有二三十像素,
     而手指一拖就是上百像素 —— 半径比手指行程还小,几何上根本到不了,
     线性解算只能给出一个夸张的角度,再被单步上限一夹,手感就是"甩飞"(本机实测过:
     拖 110 像素转 146 度)。
     拿整根骨骼当力臂,半径就是骨长,正常拖拽都落在可达范围内;
     末端的走向与手指一致,所以手感是"把这根骨头甩向手指的方向"。
     短骨骼(脖子只有 7cm)按 LEVER_MIN 兜底,免得一像素转好几度。 */
  function leverFor(name, origin) {
    var joint = app.rig.byName(name);
    var object = state.objects[name];
    var lever = null;
    if (object && joint && joint.length > 0) {
      lever = object.localToWorld(new THREE.Vector3(0, joint.length, 0)).sub(origin);
    }
    if (!lever || lever.lengthSq() < 1e-8) lever = new THREE.Vector3(0, -LEVER_MIN, 0);
    var reach = lever.length();
    return reach < LEVER_MIN ? lever.multiplyScalar(LEVER_MIN / reach) : lever;
  }

  /* 拖连接杆 = 旋转。
     力臂取"手指按住的那个点"到关节原点的向量,所以屏幕解出来的角度正好是
     "让手下的那个点跟着手指走",不需要任何硬编码的正负号。
     三个欧拉通道里,屏幕上"没反应"的那些要先扔掉。判据是相对量:
     每弧度在屏幕上走不满最强通道的 RESPONSE_SHARE 倍,就当它不参与。
     典型反例:小人正对镜头时,手臂的屈伸通道几乎正对视线,它那点屏幕位移
     完全来自透视(往下摆的时候看起来往下走)。留着它硬解,手指往下拖 110 像素
     会解出 146 度 —— 末端绕一大圈跑到上面去,手感就是"甩飞"(本机探针实测过)。
     扔掉它之后,往下拖就只在水平方向的侧摆通道上有分量,几乎不动;
     把镜头转到侧面,屈伸通道自己就变强,竖直拖拽自然生效。
     两个屏幕自由度只能在通道里挑两个:剩下的通道里取行列式最大的一对
     (屏幕上分得最开、最跟手的一对),两轴几乎重合时退回单通道投影。 */
  function rotateBone(drag, dx, dy) {
    if (!dx && !dy) return 0;
    var origin = jointWorldPosition(drag.joint, new THREE.Vector3());
    if (!origin) return 0;
    /* 力臂不能用共享的临时向量:screenDirection 内部就要用 scratchC,会把它踩掉 */
    var lever = drag.lever || new THREE.Vector3(0, LEVER_MIN, 0);
    /* 屏幕方向在"手指按住的那个点"上量,不是在关节原点量:投影是非线性的,
       力臂越长,拿原点当基准算出来的比例越偏。 */
    var base = origin.clone().add(lever);

    var channels = [];
    var raw = [];
    var strongest = 0;
    app.rig.angleKeys.forEach(function (key) {
      var axis = channelAxisWorld(drag.joint, key);
      var motion = new THREE.Vector3().crossVectors(axis, lever);
      var screen = screenDirection(base, motion);
      var power = Math.sqrt(screen.x * screen.x + screen.y * screen.y);
      if (power > strongest) strongest = power;
      raw.push({ key: key, x: Math.round(screen.x), y: Math.round(screen.y), power: Math.round(power) });
      channels.push({ key: key, screen: screen, power: power });
    });
    channels = channels.filter(function (channel) { return channel.power >= strongest * RESPONSE_SHARE; });
    if (!channels.length) return 0;

    var best = null;
    var pairs = [[0, 1], [0, 2], [1, 2]];
    pairs.forEach(function (pair) {
      var a = channels[pair[0]];
      var b = channels[pair[1]];
      if (!a || !b) return;
      var determinant = a.screen.x * b.screen.y - b.screen.x * a.screen.y;
      if (Math.abs(determinant) < SOLVE_MIN_DETERMINANT) return;
      if (Math.abs(determinant) < SOLVE_MIN_ANGLE * a.power * b.power) return;
      if (!best || Math.abs(determinant) > Math.abs(best.determinant)) best = { a: a, b: b, determinant: determinant };
    });

    var turns = {};
    if (best) {
      turns[best.a.key] = (dx * best.b.screen.y - best.b.screen.x * dy) / best.determinant;
      turns[best.b.key] = (best.a.screen.x * dy - dx * best.a.screen.y) / best.determinant;
    } else {
      var single = channels.slice().sort(function (a, b) { return b.power - a.power; })[0];
      turns[single.key] = (dx * single.screen.x + dy * single.screen.y) / (single.power * single.power);
    }

    var patch = {};
    var moved = 0;
    var report = {};
    Object.keys(turns).forEach(function (key) {
      var turn = Math.max(-TURN_LIMIT, Math.min(TURN_LIMIT, turns[key]));
      report[key] = Math.round(turn * 180 / Math.PI * 10) / 10;
      if (Math.abs(turn) < 1e-4) return;
      patch[key] = state.angles[drag.joint][key] + turn * 180 / Math.PI;
      moved += turn * turn;
    });

    /* 诊断留档:拖不动的时候要看得出是"通道没反应"还是"方向对不上" */
    state.lastRotate = {
      joint: drag.joint,
      delta: [Math.round(dx), Math.round(dy)],
      lever: Math.round(lever.length() * 1000) / 1000,
      channels: raw,
      turns: report,
      rejected: !channels.length
    };
    if (!moved) return 0;

    app.events.emit("viewport:rotate", { joint: drag.joint, patch: patch });
    return moved;
  }

  /* 拖节点 = 移动。
     目标点取"手指在过该节点、与镜头平行的平面上的落点",再把屏幕位移原样加到节点原点上,
     于是节点跟着手指走;能不能走到由 IK 决定,走不到就是走不到(关节长度是硬的)。 */
  function moveNode(drag, clientX, clientY) {
    if (!drag.plane || !drag.anchor || !drag.tip) return 0;
    var current = rayPlanePoint(clientX, clientY, drag.plane, new THREE.Vector3());
    if (!current) return 0;

    /* 目标 = 节点**当前实际位置**(drag.tip)+ 这一帧手指的位移。
       关键在"当前实际位置"而不是"拖动开始时的位置":节点被关节限位挡住时(脚拖到
       腿长够不着的位置),从起始位置起算会让目标一路累积到身体另一侧 —— 过了临界点
       IK 会突然解出一个完全不同的姿态,真机上就是"拖脚时大腿和膝盖猛地跳一下"
       (实测膝位移一步跳 400mm)。从节点实际位置起算之后,手指继续走也不会把目标
       推得更远,走不到就是走不到(关节长度是硬的);而手指往回走时节点会立刻响应。 */
    var shift = current.clone().sub(drag.anchor);
    drag.anchor.copy(current);
    var local = worldToBbox(drag.tip.clone().add(shift));
    var solved = app.ik.solve(state.angles, { effector: drag.joint, target: local });
    if (!solved.changed || !Object.keys(solved.changed).length) return 0;

    /* 本地先落一版,拖动才跟手;上层收到事件后会回灌一次同样的姿态,幂等 */
    applyPose(solved.angles);
    /* 参照推到节点**实际**落点 —— 被限位挡住时它不会跟着手指跑。
       用 IK 解出的 bbox 坐标换算,不去读 Object3D 的 matrixWorld
       (那些节点的 matrixAutoUpdate 是 false,读到的会是上一帧)。 */
    var landed = app.rig.jointPositions(solved.angles)[drag.joint].origin;
    drag.tip = bboxToWorld(new THREE.Vector3(landed.x, landed.y, landed.z));
    app.events.emit("viewport:ik", { joint: drag.joint, angles: solved.changed });
    return 1;
  }

  function rayPlanePoint(clientX, clientY, plane, out) {
    if (!ready() || !state.canvas) return null;
    updatePointer(clientX, clientY);
    var point = out || new THREE.Vector3();
    return state.raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  function worldToBbox(point) {
    if (!state.bbox) return point;
    scratchMatrix.copy(state.bbox.matrixWorld).invert();
    return point.clone().applyMatrix4(scratchMatrix);
  }

  /* 反向:bbox 局部 → 世界。拖节点时要用它把"IK 实际把节点放到了哪"换算回世界,
     好当作下一帧的参照(见 moveNode)。 */
  function bboxToWorld(point) {
    if (!state.bbox) return point;
    return point.clone().applyMatrix4(state.bbox.matrixWorld);
  }

  function moveBody(dx, dy) {
    var distance = state.camera.position.distanceTo(state.controls.target);
    var perPixel = 2 * Math.tan(state.camera.fov * Math.PI / 360) * distance / Math.max(1, state.canvas.clientHeight);
    var right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0);
    var forward = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 2).negate();
    right.y = 0;
    forward.y = 0;
    if (right.lengthSq() > 1e-6) right.normalize();
    if (forward.lengthSq() > 1e-6) forward.normalize();
    state.bbox.position.addScaledVector(right, dx * perPixel);
    state.bbox.position.addScaledVector(forward, -dy * perPixel);
    state.bbox.updateMatrixWorld(true);
    app.events.emit("viewport:body", {
      position: { x: state.bbox.position.x, y: state.bbox.position.y, z: state.bbox.position.z }
    });
  }

  /* ---------- 指针仲裁:这一次拖拽归关节还是归相机 ----------
   *
   * 判据只有一条:手指落下的那一刻命中了关节,就归关节;否则归相机。
   *
   * 关键约束 —— **不能在 pointerdown 上 stopPropagation**:
   * 相机控件也要为"双指手势"记住每一根手指。第一根手指被吞掉之后,第二根手指补上来时
   * 它拼不出双指手势,于是"第一根手指落在模型上就捏合不动、两指也平移不了"(真机踩过,
   * 表现为双指完全无反应)。改成冻结相机控件:
   *   · 关节拖拽在第一次移动时把控件关掉 —— 控件随后收到同一个事件就直接返回,
   *     连一个像素的相机抖动都不会有(所以冻结动作放在画布的**捕获**阶段,抢在控件之前);
   *   · 第二根手指按下时立刻放弃关节拖拽、把控件打开,这串操作整个交给相机做捏合/平移。
   * 用 enabled 而不是吞事件,是因为控件在 enabled=false 时只是停手,
   * 抬起时照样清理内部指针表,不会留下脏状态。
   */

  function pointerCount() { return Object.keys(state.pointers).length; }

  /* ---------- "视图正在被操作"的信号 ----------
   *
   * 用户要求:「操作摄像机(视图)的时候,都显示:拖拽旋转视图,双指放缩,双指拖拽平移」。
   * 这句话该由状态行来说,所以视口只负责回答"现在算不算在操作视图"。
   *
   * 判据只有两条,都是"这串手势归相机"的既有结论,不另立一套:
   *   · `state.orbiting` —— 单指落在空白处、并且真的拖过了 TAP_SLOP(见 onPointerMove);
   *   · `pointerCount() > 1` —— 两根手指按着,即捏合缩放 / 双指平移(见 onPointerDown)。
   *
   * **纯点一下空白不算**。那也会走到"空白"分支上,但它只是取消选择,
   * 若据此点亮相机提示,表现就是"手指一落状态行闪一下、抬手又闪回来"(真机上是可见的抖动)。
   * 所以只在"拖动了"或"两根手指"时才发事件,并且**只在值真的变化时发一次**
   * (指针每动一像素都发一遍会让状态行反复重写同一句话)。 */
  function setCameraActive(next) {
    next = Boolean(next);
    if (state.cameraActive === next) return false;
    state.cameraActive = next;
    app.events.emit("viewport:camera", { active: next });
    return true;
  }

  function syncCameraActive() {
    return setCameraActive(pointerCount() > 1 || state.orbiting);
  }

  function freezeControls() {
    if (!state.controls || state.controlsFrozen) return;
    state.controls.enabled = false;
    state.controlsFrozen = true;
  }

  function thawControls() {
    if (!state.controls || !state.controlsFrozen) return;
    state.controls.enabled = true;
    state.controlsFrozen = false;
  }

  /* 放弃关节拖拽(不改姿态,只停止继续跟随):交给相机 */
  function abortJointDrag() {
    state.dragging = null;
    thawControls();
  }

  function onPointerDown(event) {
    if (!ready()) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    state.pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    if (pointerCount() > 1) {
      /* 第二根手指落下:这一串操作属于相机(捏合缩放 / 双指平移)。
         正在进行的关节拖拽就地停止 —— 姿态停在当前值上,不回滚、不抖。
         同时告诉上层"视图正在被操作",状态行改说相机那三件事。 */
      state.blankTap = null;
      abortJointDrag();
      syncCameraActive();
      return;
    }

    var hit = pick(event.clientX, event.clientY);

    if (state.mode === "move") {
      if (!hit.joint) return;
      state.dragging = { kind: "body", x: event.clientX, y: event.clientY };
      return;
    }

    if (!hit.joint) {
      /* 空白处:不接管,交给相机控件转视角。同时记下这次按下,
         抬起时若几乎没动,就当成"点了一下空白"用来清空选择。
         (转视角绕的是当前目标点,所以这里不动 controls.target —— 按下的一瞬间
         画面必须逐位不变,见 视图导航 一节规则 1。) */
      state.blankTap = { x: event.clientX, y: event.clientY };
      return;
    }

    /* broot 是纯变换节点,不承载姿态:它自己**既不旋转、也不移动** ——
       拖它就是"整体搬运",即移动 bbox(moveBody),姿态一个字节都不改。
       人物的整体旋转归 hips:转 hips 会带动脊柱与双腿,等于绕骨盆转一圈。
       这一条必须挡在下面按 grabMode/boneGrab 换算之前,否则 pivot 会被
       判成 bone(它的 marker 标着 part: "node",换算出来恰好是"旋转")。 */
    if (app.rig.isPivot(hit.joint)) {
      app.events.emit("viewport:picked", { joint: hit.joint, part: "node" });
      state.dragging = { kind: "body", x: event.clientX, y: event.clientY };
      return;
    }

    /* hit.part 已经是"拖动语义"(在 pick 里按命中的网格换算过),这里不要再算一遍 ——
       同一件事两处判定,迟早各说各话("小臂选不中"就是这么来的)。 */
    var kind = hit.part === "node" ? "node" : "bone";
    app.events.emit("viewport:picked", { joint: hit.joint, part: kind });

    var drag = { kind: kind, joint: hit.joint, x: event.clientX, y: event.clientY };
    var origin = jointWorldPosition(hit.joint, new THREE.Vector3());
    if (kind === "bone") {
      drag.lever = leverFor(hit.joint, origin);
    } else {
      /* tip = 节点此刻的实际位置,拖动期间每帧往它上面推(见 moveNode)。
         目标是"从 tip 出发、加上手指这一帧的位移",而不是"从起始位置加上累计位移"。 */
      drag.tip = origin;
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraForward(new THREE.Vector3()).normalize(), origin);
      drag.anchor = rayPlanePoint(event.clientX, event.clientY, drag.plane, new THREE.Vector3());
      if (!drag.anchor) {
        /* 视线与平面平行(理论上不会发生):退回旋转,别让这次拖拽变成空操作 */
        drag.kind = "bone";
        drag.lever = leverFor(hit.joint, origin);
      }
    }
    state.dragging = drag;
  }

  /* 相机控件的监听挂在画布上、走冒泡;这里在**捕获**阶段先一步动手,
     保证"这一拖属于关节"这个结论在控件收到同一个事件之前就已经生效。 */
  function onCanvasMoveCapture() {
    if (state.dragging && pointerCount() === 1) freezeControls();
  }

  function onPointerMove(event) {
    if (state.pointers[event.pointerId]) {
      state.pointers[event.pointerId].x = event.clientX;
      state.pointers[event.pointerId].y = event.clientY;
    }
    var drag = state.dragging;

    /* 拖到一半又落下一根手指 → 改判为相机手势,关节立刻停手 */
    if (drag && pointerCount() > 1) { abortJointDrag(); syncCameraActive(); return; }

    if (state.blankTap) {
      var gap = Math.abs(event.clientX - state.blankTap.x) + Math.abs(event.clientY - state.blankTap.y);
      if (gap > TAP_SLOP) {
        /* 动了就不是点击,别清选择。而且这一串从此归相机("单指拖空白转视角"),
           到抬手为止都算"在操作视图" —— 状态行据此改说相机那三件事。 */
        state.blankTap = null;
        state.orbiting = true;
        syncCameraActive();
      }
    }

    if (!drag) return;
    freezeControls();
    if (drag.kind === "body") {
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      moveBody(dx, dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
    } else if (drag.kind === "bone") {
      var stepX = event.clientX - drag.x;
      var stepY = event.clientY - drag.y;
      if (Math.abs(stepX) < 1 && Math.abs(stepY) < 1) return;
      if (!rotateBone(drag, stepX, stepY)) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
    } else {
      moveNode(drag, event.clientX, event.clientY);
    }
    if (event.cancelable) event.preventDefault();
  }

  /* 点空白 = 取消选择,但**不立刻**落地:先挂起一个双击时限。
     不这么做的话,双击回正的**第一下**就已经把选中清掉了 —— 真机表现是
     "双击把人摆正,选中的关节也跟着没了"(用户反馈)。
     相机动作一律不碰选择:拖空白转视角、双指缩放、双击回正都只走自己的分支。

     挂起的这段窗口里补一对 viewport:blank-pending / blank-cancel:
     纯视觉的东西(自转滑杆)不该陪着等满 320ms —— 等满的手感就是
     "点了空白,控件慢半拍才走"(用户反馈)。挂起时先收起来,双击成立再放回去。
     选中本身仍旧只等 viewport:blank,所以双击回正照样不会丢选中。 */
  function scheduleBlank() {
    cancelBlank();
    app.events.emit("viewport:blank-pending", {});
    state.blankTimer = setTimeout(function () {
      state.blankTimer = null;
      app.events.emit("viewport:blank", {});
    }, DOUBLE_TAP_MS);
  }

  function cancelBlank() {
    if (!state.blankTimer) return;
    clearTimeout(state.blankTimer);
    state.blankTimer = null;
  }

  function onPointerUp(event) {
    if (event && event.pointerId !== undefined) delete state.pointers[event.pointerId];
    if (pointerCount() > 0) { syncCameraActive(); return; }   /* 还有手指按着,这一串手势没结束 */
    state.orbiting = false;
    state.dragging = null;
    thawControls();
    /* 手势收尾:两根手指抬掉一根、或最后一根抬起来,都到这里 —— 视图提示随之收起 */
    setCameraActive(false);
    if (!state.blankTap) return;
    var tap = state.blankTap;
    state.blankTap = null;
    var previous = state.lastBlankTap;
    var now = Date.now();
    state.lastBlankTap = { time: now, x: tap.x, y: tap.y };
    var isDouble = previous
      && now - previous.time <= DOUBLE_TAP_MS
      && Math.abs(tap.x - previous.x) <= DOUBLE_TAP_PX
      && Math.abs(tap.y - previous.y) <= DOUBLE_TAP_PX;
    /* 无论这一次是单击还是双击,前一下挂起的"清选择"都要先撤掉:
       双击的第一下就是它把选中清空的。 */
    cancelBlank();
    if (isDouble) {
      /* 空白处双击 = 整个人回到画面正中(交给上层去取景)。用掉这一对,
         免得"连点三下"又凑出一次双击,画面连着重取两次。 */
      state.lastBlankTap = null;
      app.events.emit("viewport:blank-cancel", {});   /* 撤掉第一下引起的"临时收起" */
      app.events.emit("viewport:reframe", {});
      return;
    }
    scheduleBlank();
  }

  /* ---------- 尺寸与上下文 ---------- */

  function showFallback(message) {
    var hint = document.getElementById("stage-fallback");
    if (!hint) return;
    hint.hidden = false;
    hint.textContent = message;
  }

  function hideFallback() {
    var hint = document.getElementById("stage-fallback");
    if (hint) hint.hidden = true;
  }

  function resize() {
    if (!state.renderer || !state.container) return;
    var width = Math.max(1, state.container.clientWidth);
    var height = Math.max(1, state.container.clientHeight);
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }

  function onContextLost(event) {
    if (event.cancelable) event.preventDefault();
    state.lost = true;
    state.reason = text("图形上下文丢失,正在等待恢复", "Graphics context lost, waiting to recover");
    showFallback(state.reason);
    app.events.emit("viewport:lost", { reason: state.reason });
  }

  function onContextRestored() {
    state.lost = false;
    state.reason = "";
    rebuild();
    hideFallback();
    app.events.emit("viewport:restored", {});
  }

  function rebuild() {
    disposeSceneContents();
    /* 重建会把指针表清空,"视图正在被操作"这件事也跟着归零 —— 顺手把提示收掉 */
    state.orbiting = false;
    setCameraActive(false);
    buildAssets();
    buildScene();
    buildRig();
    applyPose(state.angles || app.rig.defaultAngles());
    highlight(state.selected, state.selectedPart);
    resize();
    app.events.emit("viewport:ready", { rebuilt: true });
  }

  function disposeSceneContents() {
    /* 几何体与材质都由 state.assets 统一持有,这里只解场景自身的引用。
       例外是环境球:它的几何体与材质都是就地新建的,要显式释放。 */
    disposeEnvironment();
    state.boxHelper = null;
    state.scene = null;
    state.camera = null;
    state.bbox = null;
    state.controls = null;
    state.objects = {};
    state.parts = {};
    state.figure = null;
    state.pickables = [];
    state.bones = [];
  }

  /* ---------- 渲染循环 ---------- */

  function tick() {
    if (state.disposed) return;
    state.frame = window.requestAnimationFrame(tick);
    if (!ready() || document.hidden) return;
    /* 这里**不碰** controls.target:目标只能由"平移"和"适配屏幕"改(规则 1/3),
       逐帧同步回人物会把平移抹掉,也会让绕转起点变得不可预测。 */
    if (state.controls) state.controls.update();
    state.renderer.render(state.scene, state.camera);
  }

  /* ---------- 对外接口 ---------- */

  function init(container) {
    state.container = container || state.container;
    var result = detect();
    state.available = result.available;
    state.reason = result.reason;

    if (!state.container) return false;
    if (!state.available) {
      showFallback(state.reason);
      app.events.emit("viewport:unavailable", { reason: state.reason });
      return false;
    }

    try {
      var canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", text("3D 造型视口", "3D posing viewport"));
      state.container.appendChild(canvas);
      state.canvas = canvas;

      var renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true
      });
      renderer.setClearColor(THEMES[themeName].env.sky, 1);
      if ("outputEncoding" in renderer && THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
      state.renderer = renderer;

      state.raycaster = new THREE.Raycaster();
      state.pointer = new THREE.Vector2();

      /* 先挂捕获阶段的指针监听,再建 OrbitControls:
         命中关节时 stopPropagation,事件根本到不了画布,轨道旋转自然让位给关节拖拽。 */
      state.container.addEventListener("pointerdown", onPointerDown, true);
      /* 捕获阶段:抢在画布上的相机控件之前,决定这一拖归不归它 */
      canvas.addEventListener("pointermove", onCanvasMoveCapture, true);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("webglcontextlost", onContextLost, false);
      canvas.addEventListener("webglcontextrestored", onContextRestored, false);

      rebuild();
      hideFallback();

      state.controls = new THREE.OrbitControls(state.camera, canvas);
      /* 目标初始落在人物胯骨上;真正的取景由下面 frameCamera 完成 */
      state.controls.target.copy(pelvisPoint());
      state.controls.enableDamping = true;
      state.controls.dampingFactor = 0.12;
      state.controls.rotateSpeed = 0.85;
      state.controls.zoomSpeed = 0.9;
      state.controls.minDistance = 0.7;
      state.controls.maxDistance = 9;
      state.controls.maxPolarAngle = Math.PI * 0.495;
      state.controls.update();

      /* 建完控件先取一次景:屏幕多高都让小人恰好占满,不靠写死的相机距离 */
      frameCamera();

      if (window.ResizeObserver) {
        state.observer = new window.ResizeObserver(resize);
        state.observer.observe(state.container);
      }
      window.addEventListener("resize", resize);
      document.addEventListener("visibilitychange", resize);

      tick();
      app.events.emit("viewport:ready", {
        version: app.version,
        three: THREE ? THREE.REVISION : "",
        joints: app.rig.joints.length
      });
      return true;
    } catch (error) {
      state.available = false;
      state.reason = text("3D 场景建立失败:", "Could not build the 3D scene: ") + app.utils.cleanError(error);
      showFallback(state.reason);
      app.events.emit("viewport:unavailable", { reason: state.reason });
      return false;
    }
  }

  function setPose(angles) { return applyPose(angles || app.rig.defaultAngles()); }

  /* ---------- 视图导航:一个目标点 + 三种动作 ----------
   *
   * 用户 2026-09-25 定下的三条规则(就是标准 3D 视图导航模型):
   *
   *   1. **转视角(拖空白)总是绕"当前目标" controls.target 转。**
   *      而且**绕转开始时绝不改动目标** —— 所以手指按下去的那一瞬间画面不会先挪一下。
   *      绕转只改相机的位置与朝向,目标一动不动。
   *   2. **双击空白(适配屏幕)把目标复位到人物胯骨**,再按全身包围盒把画面重排一遍。
   *   3. **平移(双指拖)会移动目标本身。** 目标与相机一起走,画面里的东西跟着手指动;
   *      平移之后再转视角,绕的就是平移后的新目标 —— 这正是标准做法。
   *
   * 目标**只**由这两件事改:平移、适配屏幕。
   * 选中关节、拖肢体、搬人物都不碰它 —— 所以"选中谁"永远不会把画面搬走。
   *
   * 关键简化:相机看向哪 = 绕哪转 = 同一个点(OrbitControls 的原生语义),
   * 于是不存在"两套朝向",也不需要任何逐帧补偿。
   * (历史:为了做"绕所选部件转、但不把它摆到画面正中",曾经把这两件事拆成两个点,
   *  还配了刚性旋转与屏位闭环。目标不再随手势重落之后,那套机制整体删掉了 ——
   *  它唯一的作用就是"相机不看向目标",而现在目标本来就该被看着。) */

  /* 人物胯骨在世界里的位置:适配屏幕时目标回到这里。
     拿不到骨架时退回包围盒中心高度,再退回原点。 */
  function pelvisPoint() {
    var object = state.objects.hips || state.objects.broot;
    if (object) return object.getWorldPosition(new THREE.Vector3());
    return new THREE.Vector3(0, BBOX_SIZE.centerY, 0);
  }

  /* 选中只改高亮。轨道目标与选中无关(规则 1),所以这里没有别的事要办 ——
     相机手势开始时也不用"重落目标",画面上不会有"选中谁就把画面搬走"那一下。 */
  function setSelectedJoint(name, part) {
    highlight(name, part);
  }

  function setMode(mode) {
    state.mode = mode === "move" ? "move" : "pose";
    if (state.boxHelper) state.boxHelper.visible = state.mode === "move";
    return state.mode;
  }

  function body() {
    if (!state.bbox) return { position: { x: 0, y: 0, z: 0 } };
    return { position: { x: state.bbox.position.x, y: state.bbox.position.y, z: state.bbox.position.z } };
  }

  function resetBody() {
    if (!state.bbox) return body();
    state.bbox.position.set(0, 0, 0);
    state.bbox.quaternion.identity();
    state.bbox.updateMatrixWorld(true);
    app.events.emit("viewport:body", { position: { x: 0, y: 0, z: 0 } });
    return body();
  }

  /* 取景:让小人恰好占满舞台。
     立方体只按"关节原点"量会漏掉头和脚(它们的原点到末端还有一段),
     本机渲染踩到过:头被顶栏切掉、脚贴到按钮条。所以起点与末端都要量进来。 */
  function frameCamera() {
    if (!state.camera || !state.controls) return;
    var box = new THREE.Box3();
    app.rig.joints.forEach(function (joint) {
      var object = state.objects[joint.name];
      if (!object) return;
      box.expandByPoint(object.getWorldPosition(new THREE.Vector3()));
      box.expandByPoint(object.localToWorld(new THREE.Vector3(0, joint.length, 0)));
    });
    if (box.isEmpty()) return;
    var size = box.getSize(new THREE.Vector3());
    /* 手机是竖屏:限制画面的是高度,所以竖横两个方向各算一次,取更远的那个距离。
       竖直余量 0.20 里有一段是**顶栏**的:顶栏改成浮在场景上的毛玻璃卡片之后,
       卡片会压住画面上沿,取景必须给它留出高度,否则举手动作的头和手会被卡片切掉。
       (0.14 → 0.20:手机上人物占比 0.80→0.76,上沿留白约 120 像素,卡片 54 像素。) */
    var vertical = size.y * 0.54 + 0.20;
    var horizontal = (size.x * 0.54 + 0.14) / Math.max(0.3, state.camera.aspect);
    var distance = Math.max(vertical, horizontal) / Math.tan(state.camera.fov * Math.PI / 360);
    /* 目标复位到胯骨(规则 2),相机摆到"目标 + 当前观察方向 × 新距离"上。
       方向量的是**同一个点**(目标本身),所以取景是幂等的:
       连按两次"取景"结果一样。此前方向量的是脚下的支点、摆位用的是腰上的取景中心,
       两个原点不一致,每取一次景相机就绕中心多转一点(实测仰角 0.81→0.63),
       真机上表现为"连着双击两下,人物一次比一次低"。 */
    var target = pelvisPoint();
    var direction = state.camera.position.clone().sub(target);
    if (direction.lengthSq() < 1e-6) direction.set(0.25, 0.3, 1);
    direction.normalize();
    state.controls.target.copy(target);
    state.camera.position.copy(target).addScaledVector(direction, distance);
    /* 取景必须把"还没散掉的转动余量"清干净。
       enableDamping 让上一次拖拽的速度继续生效若干帧:取景刚摆正,余量又把相机
       从目标的球面上转走 —— 人物就一路飘出画面(实测双击回正后人物框中心
       跑到画布上方 150 像素)。
       关掉阻尼跑一次 update() 会清空余量(OrbitControls 里只有非阻尼分支做这件事),
       取完景再打开。 */
    var damping = state.controls.enableDamping;
    state.controls.enableDamping = false;
    state.controls.update();
    state.controls.enableDamping = damping;
  }

  function renderFrame() {
    state.renderer.render(state.scene, state.camera);
  }

  function capture() {
    if (!ready()) throw new Error(text("3D 视口不可用,无法截图", "The 3D viewport is unavailable, so it cannot be captured"));
    renderFrame();
    var dataUrl = state.canvas.toDataURL("image/png");
    return {
      dataUrl: dataUrl,
      imageBase64: dataUrl.replace(/^data:[^,]+,/, ""),
      mime: "image/png",
      width: state.canvas.width,
      height: state.canvas.height
    };
  }

  /* 按目标分辨率出图:临时改绘制缓冲,取完立刻还原并重画一帧。
     生图要的是长边 768 以上的干净图,屏幕上那块画布太小。 */
  /* 截一张指定尺寸的渲染图。第三个参数只管编码:默认 PNG(无损),
     要交给模型时用 JPEG —— 原因在 app.js 的 captureSquare 里写清楚了。 */
  function captureAt(width, height, encoding) {
    if (!ready()) throw new Error(text("3D 视口不可用,无法截图", "The 3D viewport is unavailable, so it cannot be captured"));
    var targetWidth = Math.max(64, Math.round(Number(width) || 768));
    var targetHeight = Math.max(64, Math.round(Number(height) || 1024));
    var options = encoding || {};
    var format = options.format === "image/jpeg" ? "image/jpeg" : "image/png";
    var quality = typeof options.quality === "number" ? options.quality : 0.92;
    var restoreWidth = state.container.clientWidth;
    var restoreHeight = state.container.clientHeight;
    var restoreAspect = state.camera.aspect;

    state.renderer.setPixelRatio(1);
    state.renderer.setSize(targetWidth, targetHeight, false);
    state.camera.aspect = targetWidth / targetHeight;
    state.camera.updateProjectionMatrix();
    renderFrame();
    var dataUrl = format === "image/jpeg" ? state.canvas.toDataURL(format, quality) : state.canvas.toDataURL("image/png");

    state.camera.aspect = restoreAspect;
    state.camera.updateProjectionMatrix();
    resize();
    renderFrame();

    return {
      dataUrl: dataUrl,
      imageBase64: dataUrl.replace(/^data:[^,]+,/, ""),
      mime: format,
      width: targetWidth,
      height: targetHeight,
      restored: { width: restoreWidth, height: restoreHeight }
    };
  }

  function view() {
    if (!state.camera || !state.controls) return { azimuth: 0, elevation: 0, distance: 0, targetY: 0 };
    var offset = state.camera.position.clone().sub(state.controls.target);
    var distance = offset.length();
    return {
      azimuth: Math.atan2(offset.x, offset.z),
      elevation: Math.asin(distance > 0 ? offset.y / distance : 0),
      distance: distance,
      targetY: state.controls.target.y
    };
  }

  /* 设备端诊断用:相机的世界位置与朝向、目标点,一次全给出来。
     "转视角时目标动了没""平移有没有真的把目标搬走""双击之后目标回没回到胯骨"
     这类问题只能靠这几个数字判决,不用猜。 */
  function cameraState() {
    if (!state.camera || !state.controls) return null;
    var triple = function (v) { return v ? [v.x, v.y, v.z] : null; };
    var quaternion = state.camera.quaternion;
    return {
      position: triple(state.camera.position),
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      forward: triple(state.camera.getWorldDirection(new THREE.Vector3())),
      target: triple(state.controls.target),
      pelvis: triple(pelvisPoint())
    };
  }

  function counts() {    return {
      joints: app.rig.joints.length,
      meshes: state.pickables.length,
      drawCalls: state.renderer ? state.renderer.info.render.calls : 0
    };
  }

  /* 设备端诊断用:不点屏幕,直接问"这个屏幕坐标会命中谁" */
  function probe(clientX, clientY) {
    var hit = pick(clientX, clientY);
    return { joint: hit.joint, part: hit.part, mode: state.mode, dragging: state.dragging ? state.dragging.kind : "" };
  }

  /* 关节原点(或骨杆末端)在画布上的位置,画布坐标。
     给"拖拽跟不跟手"提供可量化的证据:手指往下拖,屏幕上的那个点也必须往下走。 */
  function screenOf(name, atTail) {
    if (!ready()) return null;
    var object = state.objects[name];
    if (!object) return null;
    var joint = app.rig.byName(name);
    var point = atTail && joint && joint.length > 0
      ? object.localToWorld(new THREE.Vector3(0, joint.length, 0))
      : object.getWorldPosition(new THREE.Vector3());
    return toScreen(point);
  }

  /* 上一次旋转的中间量:三个通道各自在屏幕上每弧度走多少像素、解出来的转角是多少。
     "拖不动"到底是通道没反应还是方向对不上,看这个就知道,不用猜。 */
  function rotateDebug() { return state.lastRotate; }

  function dispose() {
    state.disposed = true;
    cancelBlank();          /* 挂起的"点空白清选择"要一起撤掉,否则销毁后还会发事件 */
    if (state.frame) window.cancelAnimationFrame(state.frame);
    state.frame = 0;
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", resize);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (state.container) state.container.removeEventListener("pointerdown", onPointerDown, true);
    if (state.canvas) state.canvas.removeEventListener("pointermove", onCanvasMoveCapture, true);
    if (state.controls && state.controls.dispose) state.controls.dispose();
    disposeSceneContents();
    disposeAssets();
    if (state.renderer) {
      state.renderer.dispose();
      if (state.renderer.forceContextLoss) state.renderer.forceContextLoss();
    }
    state.renderer = null;
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    state.canvas = null;
    state.available = false;
  }

  app.components.viewport = {
    init: init,
    available: function () { return state.available && !state.lost; },
    reason: function () { return state.reason; },
    setPose: setPose,
    setSelectedJoint: setSelectedJoint,
    setMode: setMode,
    mode: function () { return state.mode; },
    /* 正反着色:三档循环(无 / 白灰 / 红绿),纯显示视图,不碰姿态数据、不碰光照与主题 */
    setFrontBackMask: setFrontBackMask,
    frontBackMask: frontBackMask,
    maskMode: maskMode,
    maskInfo: maskInfo,
    setTheme: function (name) {
      themeName = name === "dark" ? "dark" : "light";
      paintTheme();
      return themeName;
    },
    theme: function () { return themeName; },
    body: body,
    resetBody: resetBody,
    pick: pick,
    probe: probe,
    screenOf: screenOf,
    rotateDebug: rotateDebug,
    capture: capture,
    captureAt: captureAt,
    /* 换造型:只换骨架与几何,不动场景、相机与轨道控件 ——
       于是"换个模型"不会把视角或双指手势的手感弄丢。 */
    setFigure: setFigure,
    /* 当前用的是哪个造型:模型 id(没有装模型时为空串)。设备端诊断用。 */
    figure: function () { return state.figure ? state.figure.id : ""; },
    frameCamera: frameCamera,
    view: view,
    cameraState: cameraState,
    counts: counts,
    render: function () { if (ready()) renderFrame(); },
    dispose: dispose
  };
})(window.posegi);
