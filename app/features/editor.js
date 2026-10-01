/* 页面装配:把界面按钮接到接口上
 *
 * 责任:绑定 DOM 事件、更新状态行、把错误变成提示。不承载业务规则。
 * 约定:所有可点元素都带 data-menu / data-pose / data-joint / data-action,便于 verify.mjs 断言。
 *
 * 界面结构:顶栏 + 全屏 3D 舞台 + 一排浮动按钮。剩下的工具(姿态、选取、工具、渲染、生成)
 * 一律是底部 sheet —— 点按钮才出现,不占场景。所以这些面板的 DOM 都是"打开时才存在"的,
 * 各自的绑定写在 openSheet 的 onMount 里,而不是 init 里。
 *
 * 底部按钮与菜单的分工(2026-09-25 改版):
 *   姿态  = 一整套预设       选取 = 关节选择与微调(原来的「关节」)
 *   工具  = 左右镜像 / 相机归位(原来的「搬运」,并把取景按钮收进来;
 *           「搬运」本身已在 2026-09-30 按用户要求去掉)
 *   渲染  = 正反黑白与彩色骨架检查层   生成 = 出图
 */
(function (app) {
  "use strict";

  function node(id) { return document.getElementById(id); }
  function text(zh, en) { return app.i18n.text(zh, en); }
  function esc(value) { return app.utils.escapeHtml(value); }

  function status(message) {
    app.state.status = String(message || "");
    var line = node("status-line");
    if (line) {
      line.textContent = app.state.status;
      /* 生成期间状态行前面挂一枚转圈(::before,见 components.css 的
         .stage-caption.is-busy)—— 用伪元素而不是子节点,于是 textContent 这一句
         不会把它冲掉。状态行在生成弹窗关掉之后是唯一的进度显示,那几秒的停顿
         全靠这枚转圈证明"还在跑"。 */
      line.classList.toggle("is-busy", Boolean(app.services.imageEngine && app.services.imageEngine.busy()));
    }
    return app.state.status;
  }

  function defaultStatus() {
    return text("拖连接杆旋转,拖节点移动;拖空白处转视角,双击空白回正", "Drag a bone to rotate, a joint to move it; drag the background to orbit, double-tap to reframe");
  }

  /* 顶栏那行标题:显示**当前文档(作品)的标题**(2026-09-30 用户要求「版本号后面
     间隔一点,增加显示当前文档标题」)。订阅 work:changed —— 换作品、新建作品、
     改标题、删掉当前作品四条路径都汇到 store.applyToState,由它发这一个事件
     (见 store.js 的 applyToState),所以这里不必分四种情况各接一次。
     没有标题时把整块收回:hidden 是**显式**写进 CSS 的(styles/base.css 的
     .topbar-title[hidden]),作者样式里的 display 会盖过浏览器对 [hidden] 的默认处理。
     函数本身也要能扛住"没有作品":那时 textContent 是空串,不是 "undefined"。 */
  function syncWorkTitle() {
    var label = node("app-title");
    if (!label) return;
    var title = String(app.state.workTitle || "").trim();
    label.textContent = title;
    label.hidden = !title;
  }

  var AXIS_LABEL = [
    { key: "x", zh: "屈伸", en: "Bend" },
    { key: "y", zh: "自转", en: "Twist" },
    { key: "z", zh: "侧摆", en: "Splay" }
  ];

  /* 关节面板里可以直接点选的部位。不列 hips / chest 这类躯干根节点,
     它们没有可拖的节点球,列出来只会让人以为点不动。 */
  var PICK_ORDER = [
    "head", "neck",
    "shoulder.L", "upperArm.L", "forearm.L", "hand.L",
    "shoulder.R", "upperArm.R", "forearm.R", "hand.R",
    "chest", "spine",
    "thigh.L", "shin.L", "foot.L",
    "thigh.R", "shin.R", "foot.R"
  ];

  function jointLabel(name) {
    var joint = app.rig.byName(name);
    if (!joint) return String(name || "");
    return text(joint.label[0], joint.label[1]);
  }

  function describeSelection(joint, part) {
    if (!joint) return defaultStatus();
    var hint = part === "node" ? text("拖动移动这个节点", "drag to move this joint") : text("拖动绕此关节旋转", "drag to rotate");
    return jointLabel(joint) + "(" + hint + ")";
  }

  /* 状态行末尾补一句"自转在哪调"。自转是拖拽够不到的那一个通道,不提示就等于没有。 */
  function twistHint() {
    return twistTarget() && !twistSuppressed ? text(",自转用底部滑杆", ", twist with the slider below") : "";
  }

  /* 当前状态行该说的那句:**有选中就讲这个关节怎么拖,没选中就是默认那句**。
     相机的提示退出时、滑杆收放时都回来调它,所以抽成一处 ——
     两处各写一遍迟早各说各话(曾经就是"改了一处、另一处还留着旧文案")。 */
  function poseStatus() {
    return describeSelection(app.state.selectedJoint, app.state.selectedPart) + twistHint();
  }

  /* 操作视图(相机)时状态行改说这几件事 —— 用户要求
     「操作摄像机(视图)的时候,都显示:拖拽旋转视图,双指放缩,双指拖拽平移」+「双击归位」。
     由 viewport:camera 驱动:单指在空白处**真的拖起来**、或有第二根手指落下时亮,抬手还原;
     纯点一下空白不算(否则状态行会闪一下)。 */
  function cameraStatus() {
    return text("拖拽旋转视图,双指放缩,双指拖拽平移,双击归位",
      "Drag to orbit the view, pinch to zoom, two-finger drag to pan, double-tap to reframe");
  }

  /* ---------- 菜单 ---------- */

  function bindMenu() {
    var button = node("open-menu");
    var menu = node("app-menu");
    if (!button || !menu) return;
    function close() {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    button.onclick = function () {
      var open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    /* 点菜单以外的地方就收起来(2026-09-26 用户要求)。
       用 pointerdown 且走**捕获阶段**:click 要等手指抬起,菜单会慢半拍才消失;
       捕获能抢在下层元素 stopPropagation 之前收到 —— 3D 视口会拦住 pointer 事件。
       两个例外必须排除,否则菜单"开了立刻被关":按钮自己、菜单面板内部。 */
    document.addEventListener("pointerdown", function (event) {
      if (menu.hidden) return;
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("#app-menu") || target.closest("#open-menu")) return;
      close();
    }, true);
    menu.addEventListener("click", function (event) {
      var target = event.target.closest("[data-menu]");
      if (!target) return;
      close();
      var action = target.dataset.menu;
      if (action === "newwork") openAddWorkSheet({});
      if (action === "editwork") openEditWorkSheet();
      if (action === "results") openResultsSheet();
      if (action === "addmodel") app.components.settings.openAddModel("");
      if (action === "models") app.components.settings.openModels({ back: "" });
      if (action === "preferences") app.components.settings.openPreferences();
      if (action === "help") app.components.settings.openHelp();
      if (action === "about") app.components.settings.openAbout();
    });
  }

  /* ---------- 添加作品 ----------
   * 2026-09-25 用户要求:入口从「作品库」挪到右上角菜单顶部,列表页只留已有的作品。
   * 标题可留空(自动取「未命名作品 N」),角色描述给一句默认值(一个科幻女战士),
   * 两样都可以之后在作品列表里改。
   *
   * 第一次启动时也走这一个表单(见 app.js 的 openStartupWork):所以它带 firstRun 参数,
   * 只是把标题与说明换一换,字段与写入路径完全一样 —— 不做第二套新建逻辑。 */
  function openAddWorkSheet(options) {
    var first = Boolean(options && options.firstRun);
    var html = '<label class="field"><span>' + text("标题(留空自动取名)", "Title (auto-named when empty)") + '</span>' +
      '<input name="title" type="text" value="" placeholder="' + esc(app.services.store.untitledTitle()) + '"></label>' +
      '<label class="field"><span>' + text("角色描述", "Description") + '</span>' +
      '<textarea name="prompt" rows="3" placeholder="' + esc(text("例如:一个女孩站在海边,傍晚的光", "For example: a girl standing by the sea at dusk")) + '">' +
      esc(app.services.store.defaultPrompt()) + "</textarea></label>" +
      '<p class="field-help">' + text("描述可以留空,也可以之后再改。它会跟着这件作品一起保存。",
        "You can leave the description empty and edit it later. It is saved with this artwork.") + "</p>";

    app.components.ui.openSheet({
      eyebrow: first ? text("开始", "Getting started") : text("生成", "Generation"),
      title: first ? text("先建一件作品", "Create your first artwork") : text("添加作品", "Add artwork"),
      bodyHtml: html,
      footerHtml: '<button class="button button-primary button-block" data-create type="button">' +
        text(first ? "建好并开始" : "建好并打开", first ? "Create and start" : "Create and open") + "</button>" +
        (first ? "" : '<button class="button button-secondary" data-close-modal type="button">' + text("取消", "Cancel") + "</button>"),
      onMount: function (content, actions) {
        actions.querySelector("[data-create]").onclick = app.components.ui.action(async function () {
          var title = content.querySelector('[name="title"]').value;
          var prompt = content.querySelector('[name="prompt"]').value;
          await app.services.store.newWork(title, prompt);
          app.components.ui.closeSheet();
          app.components.ui.toast(text("新作品已建好", "New artwork created"));
          status(text("当前作品:", "Current artwork: ") + app.state.workTitle);
        });
        /* 首次启动那个表单里没有取消按钮,顶栏那颗叉也要能在没建作品时关掉它 */
        Array.prototype.forEach.call(actions.querySelectorAll("[data-close-modal]"), function (button) {
          button.onclick = app.components.ui.closeSheet;
        });
      }
    });
  }

  /* ---------- 截图 3D 视口 ----------
   * 2026-09-25 用户要求:「增加一个照相机按钮点击截图 3D 视口并拉起保存图片」。
   * 两件事:截当前视口的图(长边按屏幕像素放大到 1600,PNG 无损),
   * 再交给宿主 files.export 弹系统保存框(见 platform/haminn.js 的 saveImage)。
   * 与生图那张参考图不是一回事:那张固定 9:16、高度 1024、JPEG、只为喂模型;
   * 这张要按屏幕上的构图原样取景,人眼看到什么就存下什么。 */
  function stageShotSize() {
    var stage = node("stage-viewport");
    var width = (stage && stage.clientWidth) || window.innerWidth;
    var height = (stage && stage.clientHeight) || window.innerHeight;
    var scale = Math.min(2, 1600 / Math.max(width, height, 1));
    return { width: Math.max(64, Math.round(width * scale)), height: Math.max(64, Math.round(height * scale)) };
  }

  function shotFileName() {
    var stamp = new Date();
    var pad = function (value) { return (value < 10 ? "0" : "") + value; };
    var title = String(app.state.workTitle || "").trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 24);
    return "PoseGi-" + (title ? title + "-" : "") +
      stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + "-" +
      pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + ".png";
  }

  async function captureStage() {
    var size = stageShotSize();
    var shot = app.components.viewport.captureAt(size.width, size.height, { format: "image/png" });
    status(text("正在保存截图…", "Saving the screenshot…"));
    var result = await app.platform.haminn.saveImage(shot, shotFileName());
    if (result && result.cancelled) {
      status(text("已取消保存", "Save cancelled"));
      return result;
    }
    status(text("截图已保存", "Screenshot saved"));
    app.components.ui.toast(text("截图已保存", "Screenshot saved"));
    return result;
  }

  /* ---------- 底部 sheet:姿态 ---------- */

  function openPoseSheet() {
    var html = '<div class="pose-grid">';
    app.rig.presets.forEach(function (preset) {
      html += '<button class="pose-tile" data-pose="' + esc(preset.id) + '">' +
        '<i class="fa-solid fa-person" aria-hidden="true"></i>' +
        "<span>" + esc(text(preset.label[0], preset.label[1])) + "</span></button>";
    });
    html += "</div>";
    html += '<p class="sheet-note">' + text(
      "预设是一整套姿态,套用后会覆盖当前造型。",
      "A preset is a whole pose, so applying one replaces the current figure."
    ) + "</p>";

    app.components.ui.openSheet({
      eyebrow: text("造型", "Pose"),
      title: text("姿态", "Presets"),
      bodyHtml: html,
      onMount: function (content) {
        Array.prototype.forEach.call(content.querySelectorAll("[data-pose]"), function (button) {
          button.onclick = function () {
            app.features.poser.applyPreset(button.dataset.pose);
            status(text("已套用预设:", "Preset applied: ") + button.textContent.trim());
          };
        });
      }
    });
  }

  /* ---------- 底部 sheet:选取(关节) ---------- */

  /* 关节列表的折叠状态。一条规则 + 一处状态,读写都走这一个函数 ——
     点选对象之后(传一个关节名)那张列表就该让位,收成一个小三角;
     选中被清空(传空)则摊开,那时列表是唯一还能做的事,收起来等于没入口。
     **状态必须放在模块里**:renderJointPanel 每次选中变化都整块重画 innerHTML,
     状态挂在 DOM 上(比如给元素加个类)会在下一次重画时丢掉。
     导出是为了让 tests/pick-fold.test.mjs 直接钉住这条规则 —— 它藏在事件回调里的话,
     只有真机点一遍才看得出来。 */
  var pickFolded = false;

  function pickListFolded(joint) {
    if (arguments.length) pickFolded = Boolean(joint);
    return pickFolded;
  }

  function childOf(name) {
    var order = app.rig.names();
    for (var index = 0; index < order.length; index += 1) {
      var joint = app.rig.byName(order[index]);
      if (joint && joint.parent === name) return joint.name;
    }
    return "";
  }

  function parentOf(name) {
    var joint = app.rig.byName(name);
    return joint && joint.parent ? joint.parent : "";
  }

  function mirrorOf(name) {
    var joint = app.rig.byName(name);
    if (!joint) return "";
    var twin = app.rig.mirrorName(name);
    return twin && twin !== name && app.rig.byName(twin) ? twin : "";
  }

  /* 骨架里的三个方向。父层 / 子层 / 对面都要"走了才说话" ——
     到头了(没有父、没有子、没有对称件)就明确说一声,而不是让按钮点了没反应。 */
  function walk(direction) {
    var current = app.state.selectedJoint;
    if (!current) {
      status(text("先选一个关节", "Select a joint first"));
      return false;
    }
    var target = direction === "parent" ? parentOf(current) : direction === "child" ? childOf(current) : mirrorOf(current);
    if (!target) {
      status(text("这个关节没有", "This joint has no ") + (direction === "parent" ? text("父层", "parent") : direction === "child" ? text("子层", "child") : text("对面", "mirror")));
      return false;
    }
    app.features.poser.selectJoint(target);
    status(text("已选:", "Selected: ") + jointLabel(target));
    return true;
  }

  /* 滑杆与姿态之间的两个方向。
   * 滑杆显示的是"**相对静止姿态转了多少**",写回去的是**绝对角度** —— 两边共用 rig 的那一对
   * 函数,才不会差一个 rest(脚踝的 rest 是 65 度、大腿的 rest z 是 -178.7 度,差起来很显眼)。
   * 行程取 rig.jointRange,也就是**该关节自己的解剖窗口**,不再是写死的 ±180。 */
  function axisDelta(name, key) {
    return Math.round(app.rig.relativeAngle(name, key, app.features.poser.angles()[name][key]));
  }

  function writeAxis(name, key, delta) {
    return app.features.poser.setJointAngle(name, key, app.rig.absoluteAngle(name, key, delta));
  }

  function signed(value) { return (value > 0 ? "+" : "") + value; }

  function renderJointPanel(name) {
    var panel = node("joint-panel");
    if (!panel) return;
    var joint = app.rig.byName(name);
    var html = '<div class="joint-nav">' +
      '<button class="button button-secondary" data-walk="parent" type="button"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i>' +
      text("上一个", "Back") + '</button>' +
      '<button class="button button-secondary" data-walk="child" type="button"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i>' +
      text("下一个", "Next") + '</button>' +
      '<button class="button button-secondary" data-walk="mirror" type="button"><i class="fa-solid fa-left-right" aria-hidden="true"></i>' +
      text("对面", "Mirror") + '</button></div>';

    if (joint) {
      html += '<div class="joint-head"><strong>' + esc(jointLabel(name)) + "</strong><code>" + esc(name) + "</code></div>";
      AXIS_LABEL.forEach(function (axis) {
        var range = app.rig.jointRange(name, axis.key);
        var delta = axisDelta(name, axis.key);
        html += '<div class="axis-row"><label>' + text(axis.zh, axis.en) + "</label>" +
          '<input type="range" min="' + range[0] + '" max="' + range[1] + '" step="1" data-axis="' +
          axis.key + '" value="' + delta + '"><output>' + signed(delta) + "°</output></div>";
      });
    }

    /* 列表收起来之后整块面板只剩"顶上的三个按钮 + 滑杆",高度差就是画布多露出来的那一截
       (2026-09-30 用户要求:「点选对象后下面的列表折叠为一个小三角,整个弹窗高度变小,
       只留下顶部按钮和滑竿,尽可能少遮挡画布」)。
       三角形**两种状态下都要在**:弹层背后那层 backdrop 是"点一下就关掉弹窗"的
       (index.html 的 data-close-modal),所以弹窗开着的时候没法去点空白取消选中,
       这个小三角是**唯一**能把列表翻回来的入口。做成整条都能点(不是只点那个图标),
       因为它只有 20px 高 —— 手指点不中的控件等于不存在。 */
    var folded = pickListFolded();
    html += '<div class="pick-fold">' +
      '<button class="pick-toggle" type="button" data-pick-toggle aria-expanded="' + (folded ? "false" : "true") + '">' +
      '<i class="fa-solid fa-caret-' + (folded ? "down" : "up") + '" aria-hidden="true"></i>' +
      '<span class="sr-only">' + text(folded ? "展开关节列表" : "收起关节列表",
        folded ? "Show the joint list" : "Hide the joint list") + "</span>" +
      "</button></div>" +
      '<div class="pick-grid"' + (folded ? " hidden" : "") + ">";
    PICK_ORDER.forEach(function (item) {
      var on = item === name ? " is-on" : "";
      html += '<button class="pick-tile' + on + '" data-joint="' + esc(item) + '">' + esc(jointLabel(item)) + "</button>";
    });
    html += "</div>";
    panel.innerHTML = html;

    Array.prototype.forEach.call(panel.querySelectorAll("[data-walk]"), function (button) {
      button.onclick = function () { walk(button.dataset.walk); };
    });
    var toggle = panel.querySelector("[data-pick-toggle]");
    if (toggle) toggle.onclick = function () {
      pickListFolded(!pickListFolded());
      renderJointPanel(name);
    };
    Array.prototype.forEach.call(panel.querySelectorAll("[data-joint]"), function (button) {
      button.onclick = function () {
        app.features.poser.selectJoint(button.dataset.joint);
        status(text("已选:", "Selected: ") + jointLabel(button.dataset.joint));
      };
    });
    Array.prototype.forEach.call(panel.querySelectorAll("input[data-axis]"), function (slider) {
      slider.oninput = function () {
        writeAxis(name, slider.dataset.axis, Number(slider.value));
        var output = slider.parentNode.querySelector("output");
        if (output) output.textContent = signed(axisDelta(name, slider.dataset.axis)) + "°";
      };
    });
  }

  /* 拖拽、IK 与滑杆都会改角度,统一在这里刷新数值,避免滑杆与视口打架 */
  function syncJointPanel() {
    var panel = node("joint-panel");
    if (!panel || !app.state.selectedJoint) return;
    var angles = app.features.poser.angles()[app.state.selectedJoint];
    if (!angles) return;
    Array.prototype.forEach.call(panel.querySelectorAll("input[data-axis]"), function (slider) {
      if (document.activeElement === slider) return;
      var value = axisDelta(app.state.selectedJoint, slider.dataset.axis);
      slider.value = String(value);
      var output = slider.parentNode.querySelector("output");
      if (output) output.textContent = signed(value) + "°";
    });
  }

  function openPickSheet() {
    app.components.ui.openSheet({
      eyebrow: text("造型", "Pose"),
      title: text("选取", "Pick"),
      bodyHtml: '<div class="joint-panel" id="joint-panel"></div>',
      onMount: function () { renderJointPanel(app.state.selectedJoint); }
    });
  }

  /* ---------- 常驻自转滑杆 ---------- */

  /* 自转(绕骨轴拧)是唯一"拖拽永远碰不到"的自由度:转轴就是骨头自己的轴,
     而骨的末端就在这根轴上,转它在屏幕上几乎不动(实测自转通道只有最强通道的 1~5%,
     而视口解算的丢弃线是 55%,它在第一道过滤里就被扔掉)。所以它必须有独立控件。 */
  function twistTarget() {
    var name = app.state.selectedJoint;
    if (!name || !app.rig.byName(name)) return null;
    var range = app.rig.jointRange(name, "y");
    if (!(range[1] > range[0])) return null;
    return { name: name, range: range };
  }

  /* "点空白"要挂起 DOUBLE_TAP_MS(320ms)才落地,那是为了不让双击回正的第一下
     把选中清掉(用户反馈过的真机问题,见 viewport.js 的 scheduleBlank)。
     可滑杆是纯视觉的:跟着等 320ms,手感就是"点了空白,控件慢半拍才走"。
     所以把它拆成两段 —— 挂起那一刻立刻收起滑杆(viewport:blank-pending),
     双击成立时再放回去(viewport:blank-cancel);选中本身仍旧等那 320ms 的正式事件。 */
  var twistSuppressed = false;

  function setTwistSuppressed(value) {
    twistSuppressed = value === true;
    syncTwistBar();
    status(poseStatus());
  }

  function syncTwistBar() {
    var bar = node("twist-bar");
    var input = node("twist-range");
    var output = node("twist-value");
    if (!bar || !input || !output) return null;
    var target = twistTarget();
    if (!target || twistSuppressed) {
      bar.hidden = true;
      document.body.classList.remove("has-twist");
      return null;
    }
    var axis = AXIS_LABEL[1];
    var nameNode = node("twist-name");
    var axisNode = node("twist-axis");
    var minNode = node("twist-min");
    var lower = signed(Math.round(target.range[0]));
    var upper = signed(Math.round(target.range[1]));
    if (nameNode) nameNode.textContent = jointLabel(target.name);
    if (axisNode) axisNode.textContent = text(axis.zh, axis.en);
    if (minNode) minNode.textContent = lower + "°";
    input.min = String(target.range[0]);
    input.max = String(target.range[1]);
    input.setAttribute("aria-label", jointLabel(target.name) + " " + text(axis.zh, axis.en));
    var delta = axisDelta(target.name, "y");
    /* 手指正在滑杆上时不去动它 —— 与关节面板同一条规矩,否则会被自己拖回去 */
    if (document.activeElement !== input) input.value = String(delta);
    output.textContent = signed(delta) + "°/" + upper + "°";
    bar.hidden = false;
    document.body.classList.add("has-twist");
    return target;
  }

  function bindTwistBar() {
    var input = node("twist-range");
    if (!input) return false;
    input.oninput = function () {
      var target = twistTarget();
      if (!target) return;
      writeAxis(target.name, "y", Number(input.value));
      syncTwistBar();
    };
    return true;
  }

  /* ---------- 底部 sheet:工具 ---------- */

  /* 2026-09-30 用户要求:「工具弹窗,工具-搬运工具,去掉。」
     于是「工具」这一组整组撤掉(它下面只有「搬运」一项),这个弹窗现在只剩造型与视图两组。
     搬运模式(viewport 的 setMode("move"))随之没有任何界面入口 —— 能力还在原地,
     只是不再对外露;真要搬整个人,现在靠选取 hips 之后拖。
     **别顺手把它当"没用的参数"清掉**:mode 还出现在设备自检读数里(app.js 的 scene)。 */
  function openToolsSheet() {
    var html =
      '<div class="tool-group"><span class="section-label">' + text("造型", "Pose") + "</span>" +
      '<button class="tool-row" data-action="mirror"><i class="fa-solid fa-left-right" aria-hidden="true"></i>' +
      '<span><strong>' + text("左右镜像", "Mirror") + "</strong><small>" +
      text("左右姿势整体翻转", "Flip the pose left to right") + "</small></span></button></div>" +
      '<div class="tool-group"><span class="section-label">' + text("视图", "View") + "</span>" +
      '<button class="tool-row" data-action="fit"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i>' +
      '<span><strong>' + text("相机归位", "Reset view") + "</strong><small>" +
      text("镜头回到正面,人物回到画面正中", "Return to the front view with the figure centred") + "</small></span></button></div>";

    app.components.ui.openSheet({
      eyebrow: text("造型", "Pose"),
      title: text("工具", "Tools"),
      bodyHtml: html,
      onMount: function (content) {
        Array.prototype.forEach.call(content.querySelectorAll("[data-action]"), function (button) {
          button.onclick = function () {
            if (button.dataset.action === "mirror") {
              app.features.poser.mirror();
              status(text("已左右镜像", "Pose mirrored"));
              return;
            }
            app.components.viewport.frameCamera();
            status(text("相机已归位", "View reset"));
          };
        });
      }
    });
  }

  /* ---------- 底部 sheet:渲染检查层 ---------- */

  function openRenderSheet() {
    var viewport = app.components.viewport;
    function switchRow(labelZh, labelEn, hintZh, hintEn, attribute, checked) {
      var label = text(labelZh, labelEn);
      return '<label class="switch-row render-inspect-switch"><span class="switch-text"><strong>' + esc(label) +
        '</strong><small>' + esc(text(hintZh, hintEn)) + '</small></span><span class="switch"><input type="checkbox" ' +
        attribute + ' aria-label="' + esc(label) + '"' + (checked ? " checked" : "") +
        '><span class="switch-track"></span><span class="switch-thumb"></span></span></label>';
    }

    app.components.ui.openSheet({
      eyebrow: text("检查", "Inspect"),
      title: text("渲染", "Render"),
      bodyHtml: switchRow("前后区分", "Distinguish front and back",
        "正面偏白、背面偏灰,便于检查人偶零件朝向。", "Tint the front white and the back grey to inspect part orientation.",
        "data-front-back-toggle", viewport.frontBackMask()) +
        switchRow("显示骨架", "Show skeleton",
          "叠加发给模型的彩色骨架与脸点阵,仍可拖拽关节摆姿势。", "Overlay the colour skeleton and face points sent to the model; joints stay draggable.",
          "data-skeleton-toggle", viewport.skeletonMode()),
      onMount: function (content) {
        var maskToggle = content.querySelector("[data-front-back-toggle]");
        var skeletonToggle = content.querySelector("[data-skeleton-toggle]");
        function renderStatus() {
          var active = [];
          if (viewport.frontBackMask()) active.push(text("前后区分", "Front/back"));
          if (viewport.skeletonMode()) active.push(text("显示骨架", "Skeleton"));
          status(active.length ? text("渲染:", "Render: ") + active.join(" / ") : defaultStatus());
        }
        if (maskToggle) maskToggle.onchange = function () {
          viewport.setFrontBackMask(maskToggle.checked ? 1 : 0);
          syncDock();
          renderStatus();
        };
        if (skeletonToggle) skeletonToggle.onchange = function () {
          viewport.setSkeletonMode(skeletonToggle.checked);
          syncDock();
          renderStatus();
        };
      }
    });
  }

  /* ---------- 底部 sheet:生成 ---------- */

  function resultItem(id) {
    return (app.state.results || []).filter(function (item) { return item.id === id; })[0] || null;
  }

  /* 网格里那一张右上角的叉(2026-09-30 用户要求:「渲染弹窗的历史成图,每张图片右上角
     提供一个删除按钮,删掉这个图片,不占用 12 个槽位」)。
     两点值得写下来:
       · 删除按钮是缩略图的**兄弟节点**,不是塞在它里面 —— 缩略图自己就是一个 <button>,
         里面再套一个 <button> 是非法结构,浏览器会把里层那个甩出去,于是那个叉
         要么点不到、要么连整张图一起点开;
       · **先问一句**再删:成图是本地唯一的一份,删掉找不回来。文案与全屏里那条同一个。
     删完 store 会把这一张从作品里摘掉、顺手清理它的媒体字节,槽位随之空出来 ——
     12 个槽位数的是"作品里现在存着几张",不是"这个进程里生成过几张"。 */
  async function removeResult(id) {
    var item = resultItem(id);
    if (!item) return false;
    var confirmed = await app.components.ui.confirm({
      title: text("删除这张成图?", "Delete this image?"),
      message: text("删除后无法恢复,作品里的这一张会一起消失。", "This cannot be undone; the image leaves the artwork as well."),
      okText: text("删除", "Delete")
    });
    if (!confirmed) return false;
    await app.services.store.removeResult(id);
    app.events.emit("results:changed", { id: id });
    app.components.ui.toast(text("已删除这张成图", "Image deleted"));
    return true;
  }

  function renderResults(content) {
    var grid = content.querySelector("#result-grid");
    if (!grid) return;
    var list = (app.state.results || []).slice().reverse();
    if (!list.length) {
      grid.innerHTML = '<p class="empty-hint">' + text("还没有成图。点下面的按钮生成第一张。",
        "No images yet. Generate the first one below.") + "</p>";
      return;
    }
    grid.innerHTML = list.map(function (item) {
      return '<div class="result-cell">' +
        '<button class="result-thumb" data-result="' + esc(item.id) + '" type="button">' +
        '<img src="' + esc(item.src) + '" alt="' + esc(item.prompt) + '">' +
        '<span class="result-time">' + esc(app.utils.formatTime(item.createdAt)) + "</span></button>" +
        '<button class="result-delete" data-delete-result="' + esc(item.id) + '" type="button" aria-label="' +
        esc(text("删除这张成图", "Delete this image")) + '"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' +
        "</div>";
    }).join("");
    Array.prototype.forEach.call(grid.querySelectorAll("[data-result]"), function (button) {
      button.onclick = function () {
        var item = resultItem(button.dataset.result);
        if (item) app.components.renderPreview.open(item);
      };
    });
    Array.prototype.forEach.call(grid.querySelectorAll("[data-delete-result]"), function (button) {
      button.onclick = app.components.ui.action(function () {
        return removeResult(button.dataset.deleteResult);
      });
    });
  }

  /* 作品里最后存进来的那一张 —— 网格顶上那张就是它(renderResults 先 reverse 再画) */
  function newestResultId() {
    var list = app.state.results || [];
    return list.length ? String(list[list.length - 1].id) : "";
  }

  /* 这一张现在在不在这张网格里。**不拼选择器**:拼的话 id 里一旦出现引号或方括号,
     选择器就坏了 —— 而坏掉的选择器只会静默返空,不报错。 */
  function gridHasResult(grid, id) {
    if (!grid || !id) return false;
    var cells = grid.querySelectorAll("[data-result]");
    for (var index = 0; index < cells.length; index += 1) {
      if (String(cells[index].dataset.result) === String(id)) return true;
    }
    return false;
  }

  function renderCount(content) {
    var node2 = content.querySelector("#result-count");
    if (!node2) return;
    var max = Number(app.config && app.config.maxResults) || 12;
    node2.textContent = (app.state.results || []).length + "/" + max + " " + text("张", "images");
  }

  /* ---------- 生成进度 ----------
   *
   * 用户 2026-09-30 要求:「生成的时候,加载进度动画要一直显示。(不能出现卡住的情况,
   * 有进度但优化)」。
   *
   * 为什么要在生成弹窗里再放一份:状态行在屏幕**顶端**、11.5px 灰字,而用户点完生成
   * 之后眼睛在弹窗上 —— 那里除了一颗变成"渲染中"的按钮,没有任何会动的东西,
   * 于是"没反应"与"在跑"看起来一模一样。状态行那一份继续留着:关掉弹窗之后它就是
   * 唯一的进度显示。
   *
   * 为什么"看着会卡住":CHP 插件**不报百分比**(契约明说 `progress` 恒为 null),
   * 它只报队列位置,所以两次进度变化之间可能安静十几秒。一枚常转的圈 + 一个自己走
   * 的秒数就足以证明"它还活着"—— 秒数在这里自己数,不依赖服务端,服务端不说话它照走。
   */
  var progressLine = "";
  var progressSince = 0;
  var progressTimer = 0;
  /* 正处在「重试取回」里。它只干一件事:挡住**重复弹窗** —— 续取失败会再发一次
     generation:error,不挡的话用户每点一次「重试取回」就弹一个新窗,叠成一层套一层。
     用户已经主动点了取回,那句失败话在状态行上说一次就够了。 */
  var retrieving = false;

  function progressText() {
    var base = progressLine || text("正在生成…", "Generating…");
    if (!progressSince) return base;
    return base + " · " + Math.max(0, Math.round((Date.now() - progressSince) / 1000)) + "s";
  }

  function paintProgress() {
    var strip = node("gen-progress");
    if (!strip) return;
    var busy = app.services.imageEngine.busy();
    strip.hidden = !busy;
    if (!busy) return;
    var output = node("gen-progress-text");
    if (output) output.textContent = progressText();
  }

  function startProgressTicker() {
    clearInterval(progressTimer);
    progressTimer = setInterval(paintProgress, 1000);
  }

  function stopProgressTicker() {
    clearInterval(progressTimer);
    progressTimer = 0;
    paintProgress();
  }

  /* 生成中 / 空闲两副面孔都由这里刷:标题、按钮文案、取消按钮的显隐、
     进度条、以及外面那颗按钮的图标"呼吸"状态。只有一处判断,界面不会自相矛盾。

     **它自己去取弹层根,不接受调用方传进来的元素。** 这一条是有来历的:底部那排按钮
     住在 `#modal-actions`,而它是 `#modal-content` 的**兄弟**而不是子节点(见 index.html)
     —— 所以「从内容区里 querySelector("[data-generate]")」永远是 null 而且**不报错**,
     文案、取消按钮的显隐、以及"关掉模型列表该回到生成弹窗"全都会静默失效。
     把这件事留给每个调用点,就等于留给每个人各犯一次;索性只在这里判一次。 */
  function syncGenerateSheet() {
    var sheet = sheetRoot();
    if (!sheet) return;
    var busy = app.services.imageEngine.busy();
    var generate = sheet.querySelector("[data-generate]");
    var cancel = sheet.querySelector("[data-cancel-generate]");
    if (generate) {
      generate.disabled = busy;
      generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>' +
        (busy ? text("渲染中", "Rendering") : text("立即生成新图", "Generate a new image"));
    }
    if (cancel) cancel.hidden = !busy;
    /* 有东西可取回、而且此刻不忙 —— 才摆出那个入口。没有可取的作业时它必须消失:
       一颗点了没用的按钮比没有按钮更让人困惑。 */
    var retrieve = sheet.querySelector("[data-retrieve]");
    if (retrieve) retrieve.hidden = busy || !app.services.imageEngine.pending();
    sheet.setAttribute("data-busy", busy ? "true" : "false");
    /* 弹窗是"打开时才存在"的:忙的时候重新打开它,进度条必须当场就有内容 */
    if (busy) startProgressTicker();
    paintProgress();
    syncDock();
  }

  function openGenerateSheet() {
    /* 进度条在最上面(不是压在底部):弹窗里的内容一多就要滚,
       而"还在跑"这件事任何时候都不该被滚出屏幕 —— 它还要带一枚常转的圈。 */
    var html = '<div class="gen-progress" id="gen-progress" hidden>' +
      '<span class="gen-spinner" aria-hidden="true"></span>' +
      '<span class="gen-progress-text" id="gen-progress-text"></span></div>' +
      '<div class="result-head"><span class="section-label">' + text("历史成图", "History") + "</span>" +
      '<span class="result-count" id="result-count"></span></div>' +
      '<div class="result-grid" id="result-grid"></div>' +
      '<label class="field"><span>' + text("角色描述", "Description") +
      app.components.translateHint.labelHint() + "</span>" +
      '<textarea name="prompt" rows="3" placeholder="' + esc(text("可以留空;例如:一个女孩站在海边,傍晚的光", "Optional — for example: a girl standing by the sea at dusk")) + '">' +
      esc(app.state.prompt) + "</textarea></label>";

    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: app.state.workTitle || text("出图", "Render"),
      /* 这张 sheet 的滚动只发生在缩略图那一段:角色描述与底部按钮钉住不动
         (2026-10-01 用户要求)。分法写在 styles/viewport.css 的 sheet-scroll-results 里。 */
      variant: "sheet-scroll-results",
      bodyHtml: html,
      footerHtml: '<button class="button button-primary button-block" data-generate type="button">' +
        text("立即生成新图", "Generate a new image") + '</button>' +
        /* 图标按钮只吃图标自己那么宽,不去和主按钮抢那一行。
           它进的是模型列表,关掉还会回到这个弹窗(见 openModels 的 back)。 */
        '<button class="button button-secondary button-icon" data-model-list type="button" aria-label="' +
        esc(text("模型列表", "Model list")) + '"><i class="fa-solid fa-cubes" aria-hidden="true"></i></button>' +
        /* 取回上一次没取回来的那张图。默认不显示 —— 只有手上真有一个待取的作业时
           才由 syncGenerateSheet 摆出来(见那里)。 */
        '<button class="button button-secondary" data-retrieve type="button" hidden>' +
        text("重试取回", "Retrieve") + "</button>" +
        '<button class="button button-secondary" data-cancel-generate type="button" hidden>' + text("取消", "Cancel") + "</button>",
      onMount: function (content, actions) {
        renderResults(content);
        renderCount(content);
        syncGenerateSheet();
        var prompt = content.querySelector('[name="prompt"]');
        /* 描述一改就把它存进作品。译英不在这里做 —— 它发生在提交那一刻
           (见 services/image-engine.js 的 prepare),"输入框改了旧译文要作废"这件事
           随之消失。 */
        if (prompt) prompt.oninput = function () {
          app.state.prompt = prompt.value;
          app.services.store.scheduleSave();
        };
        actions.querySelector("[data-generate]").onclick = app.components.ui.action(async function () {
          syncGenerateSheet();
          await app.services.imageEngine.run();
        });
        actions.querySelector("[data-cancel-generate]").onclick = function () {
          app.services.imageEngine.cancel();
          status(text("已取消等待这次生成", "Stopped waiting for this generation"));
        };
        actions.querySelector("[data-model-list]").onclick = function () {
          app.components.settings.openModels({ back: "generate" });
        };
        /* 取回上一次没取回来的那张图(见 image-engine 的 resume)。 */
        var retrieve = actions.querySelector("[data-retrieve]");
        if (retrieve) retrieve.onclick = app.components.ui.action(function () { return retrieveNow(); });
        /* 手里真有一个待取回的作业时,一打开这个面板就把话说出来 —— 否则用户
           重启过应用之后根本不知道还有一张图躺在服务器上。 */
        if (app.services.imageEngine.pending() && !app.services.imageEngine.busy()) {
          status(text("上次有一张图还没取回来,可以点「重试取回」拿回它", "An image from last time was never fetched; tap Retrieve to get it back."));
        }
      }
    });
  }

  /* ---------- 模型不能用时的那句话+那条路 ----------
   *
   * 用户 2026-09-30 要求:「如果不能正常使用,就弹窗提示用户去设置模型(按钮跳转过去)」。
   * 所以这里不只是"报个错":确定那一下**直接把他送到模型列表** —— 那才是能改这张卡的地方
   * (地址、密码、场景、画幅都在那一张卡上)。取消就是"以后再说"。
   *
   * 只在生成弹窗开着的时候把回退指向它:关掉模型列表该回到刚才那个弹窗上,
   * 而弹窗关着时突然弹出生成弹窗就更奇怪了。
   */
  function modelsBackTarget() {
    var sheet = sheetRoot();
    return app.components.ui.sheetOpen() && sheet && sheet.querySelector("[data-generate]") ? "generate" : "";
  }

  function askModelSetup(reason) {
    return app.components.ui.confirm({
      title: text("这个模型现在不能用", "This model is not usable right now"),
      message: String(reason || "") || text("请先检查模型设置。", "Check the model settings first."),
      okText: text("去设置模型", "Set up models"),
      cancelText: text("知道了", "Got it")
    }).then(function (go) {
      if (go) app.components.settings.openModels({ back: modelsBackTarget() });
      return go;
    });
  }

  /* ---------- 「重试取回」:把服务端那张已经画好的图拿回来 ----------
   *
   * 现场(2026-09-30):一次生成里 POST 的应答在回程丢了,作业在服务端照跑、图照落盘,
   * 而客户端连 job id 都没拿到 —— 那张图从此没人能取。现在 job id 会跟着作品落盘
   * (见 app.state.pendingJob),所以"图还在、只是没取回来"这件事**是可以被救回来的**,
   * 前提是界面上得有一个入口。
   *
   * 两个来源:生成面板里那颗按钮(用户自己想起来),以及失败弹窗里那个确定键
   * (刚失败的那一刻)。两条都走 retrieveNow,于是"重试期间别再自己弹一个弹窗"
   * 这件事只有一处判断。
   */
  function retrieveNow() {
    retrieving = true;
    return app.services.imageEngine.resume().catch(function (failure) {
      /* 续取又失败:状态行上把原因说清就够了。这里**不再弹窗** —— 用户刚点过它,
         再弹一层只会叠成一摞(而且上面那个 catching 已经把 retrieving 置上了,
         失败事件本身也不会再触发弹窗)。 */
      status(app.utils.cleanError(failure));
    }).then(function (value) {
      retrieving = false;
      return value;
    });
  }

  /* 失败弹窗。只在**可续取**的失败上出现:服务端那个作业还在(或图已经画好),
     所以这里给的是一颗"去把它拿回来"的键,而不是又一次"知道了"。 */
  function askRetrieve(error) {
    return app.components.ui.confirm({
      title: text("这一次没取到图,但任务还在", "This fetch failed, but the job is still there"),
      message: String(error && error.message || "") || text("可以再取一次。", "You can try fetching it again."),
      okText: text("重试取回", "Retrieve"),
      cancelText: text("知道了", "Got it")
    }).then(function (go) {
      if (go) retrieveNow();
      return go;
    });
  }

  /* 弹层根:底部那排按钮与内容区是兄弟,刷新必须从根上查(见 syncGenerateSheet) */
  function sheetRoot() { return node("modal-layer"); }

  /* 打开着生成弹窗时,成图一有变化就重画那两块;弹窗关着就什么都不做。
   *
   * 重画之后还要判一件事:**顶上那张是不是新画出来的** —— 是就把它滚进视野
   * (2026-10-01 用户要求:「每次有新图生成都要滚动到顶部以便用户可以看到」)。
   * 缩略图那段是这张弹窗里唯一会滚的区域(见 styles/viewport.css 的 sheet-scroll-results),
   * 而新图渲染在**最上面**,所以"让用户看见"就是滚到顶。
   *
   * 判据是"这张 id 之前不在格子里",不是"顶上的 id 变了" —— 后者会把
   * 「删掉最上面那张」也当成新图,平白把用户刚滚到的位置拉回顶。 */
  function refreshGenerateSheet() {
    var content = node("modal-content");
    if (!content || !content.querySelector("#result-grid")) return;
    var grid = content.querySelector("#result-grid");
    var incoming = newestResultId();
    var appeared = Boolean(incoming) && !gridHasResult(grid, incoming);
    renderResults(content);
    renderCount(content);
    syncGenerateSheet();
    if (appeared) grid.scrollTop = 0;
  }

  /* 作品列表(原「作品库」,2026-09-25 用户要求改名;新增作品的入口挪到菜单里) */
  function openResultsSheet() {
    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: text("作品列表", "Artwork list"),
      bodyHtml: '<div id="gallery-slot"></div>',
      onMount: function (content) {
        var slot = content.querySelector("#gallery-slot");
        if (!slot) return;
        app.components.gallery.init(slot);
        app.components.gallery.render();
      }
    });
  }

  /* 主菜单的「编辑作品」= 当前这一件的编辑表单(2026-09-30 用户要求:
     「标题行主菜单,创建作品下面添加编辑作品,打开编辑当前作品弹窗(使用作品列表的编辑作品弹窗)」)。
     **复用同一张表单**:作品列表里那个弹窗与这里这个是一份代码(openEditForm),
     差别只有一个"离开之后去哪" —— 这里背后没有列表可回,返回就直接关掉弹层。 */
  function openEditWorkSheet() {
    var id = String(app.state.workId || "");
    if (!id) {
      app.components.ui.toast(text("还没有作品,先用「添加作品」建一件", "No artwork yet — create one with Add artwork first"));
      return false;
    }
    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: text("编辑作品", "Edit artwork"),
      bodyHtml: '<div id="gallery-slot"></div>',
      onMount: function (content) {
        var slot = content.querySelector("#gallery-slot");
        if (!slot) return;
        app.components.gallery.init(slot);
        app.components.gallery.openEditForm(id, { back: "close" });
      }
    });
    return true;
  }

  /* ---------- 浮动按钮 ---------- */

  /* 底部按钮的"开着"状态集中刷:两种渲染检查层、生成中。
     几处各改一次类名,迟早有一处忘了同步(比如骨架开着却看不出)。
     2026-09-30 起这里不再管搬运:「工具」里那一项已按用户要求去掉,搬运模式没有入口,
     留着那两行只会让下一个人以为还能点亮。 */
  function syncDock() {
    var viewport = app.components.viewport;
    var render = node("toggle-render");
    if (render) render.classList.toggle("is-on", viewport.skeletonMode() || viewport.frontBackMask());
    var generate = node("open-generate");
    if (generate) generate.classList.toggle("is-busy", app.services.imageEngine.busy());
  }

  function bindDock() {
    var poses = node("open-poses");
    if (poses) poses.onclick = openPoseSheet;

    var pick = node("open-joint");
    if (pick) pick.onclick = openPickSheet;

    var tools = node("toggle-move");
    if (tools) tools.onclick = openToolsSheet;

    var render = node("toggle-render");
    if (render) render.onclick = openRenderSheet;

    var capture = node("open-capture");
    if (capture) capture.onclick = app.components.ui.action(captureStage);

    var generate = node("open-generate");
    if (generate) generate.onclick = openGenerateSheet;
  }

  /* 空白处双击:整个人回到画面正中、大小铺满舞台(与工具里的"相机归位"同一件事)。
     **不动选择** —— 相机动作一律不改"正在摆哪个关节"。 */
  function reframe() {
    app.components.viewport.frameCamera();
    status(text("相机已归位", "View reset"));
  }

  /* ---------- 事件 ---------- */

  function bindPoseEvents() {
    app.events.on("pose:selected", function (detail) {
      twistSuppressed = false;
      /* 点选了一个关节 ⇒ 把下面的列表收成一个小三角(2026-09-30 用户要求);
         选中被清空 ⇒ 摊开 —— 那时列表是唯一还能做的事,收起来等于没入口。
         判据写在这一个事件里:视口里点选、列表里点格子、上一个/下一个/对面
         三条路都只发 pose:selected(见 poser.selectJoint)。 */
      pickListFolded(detail.joint);
      renderJointPanel(detail.joint);
      syncTwistBar();
      status(poseStatus());
    });
    app.events.on("pose:changed", function () {
      syncJointPanel();
      syncTwistBar();
    });
    app.events.on("viewport:blank-pending", function () { setTwistSuppressed(true); });
    app.events.on("viewport:blank-cancel", function () { setTwistSuppressed(false); });
    app.events.on("viewport:unavailable", function (detail) { status(detail.reason); });
    app.events.on("viewport:lost", function (detail) { status(detail.reason); });
    app.events.on("viewport:restored", function () { status(text("图形上下文已恢复", "Graphics context restored")); });
    app.events.on("viewport:reframe", reframe);
    app.events.on("viewport:camera", function (detail) {
      status(detail && detail.active ? cameraStatus() : poseStatus());
    });

    /* 生图:进度走状态行与生成弹窗里那条进度条,结果刷新弹窗,失败弹提示 */
    app.events.on("generation:start", function () {
      progressLine = "";
      progressSince = Date.now();
      startProgressTicker();
      syncDock();
      syncGenerateSheet();
      status(text("开始生成…", "Generating…"));
    });
    app.events.on("generation:progress", function (detail) {
      /* 空 detail 不是"进度变成了空",而是"这一次没有新的话要说" ——
         照它把状态行清空的话,用户会看到进度凭空消失。 */
      if (!detail || !detail.detail) return;
      progressLine = String(detail.detail);
      paintProgress();
      status(progressLine);
    });
    /* 自检没过:弹窗说清是哪一句错,并给一个按钮把他送到模型设置(见 askModelSetup)。
       这里**不设状态行** —— 弹窗本身已经把话说完了。 */
    app.events.on("generation:blocked", function (detail) {
      askModelSetup(detail && detail.reason);
    });
    app.events.on("generation:done", function () {
      refreshGenerateSheet();
      status(text("生成完成", "Generated"));
    });
    app.events.on("generation:error", function (detail) {
      refreshGenerateSheet();
      status(app.utils.cleanError(detail && detail.error));
      /* 可续取的失败(服务端那个作业还在、甚至图已经画好了)多给一步:
         一颗「重试取回」。`retrieving` 挡住的是**用户在重试过程里**又失败一次的那种
         情况 —— 那时候他已经点过了,再弹一层就成一摞了。 */
      var error = detail && detail.error;
      if (error && error.recoverable && !retrieving) askRetrieve(error);
    });
    app.events.on("generation:idle", function () {
      stopProgressTicker();
      refreshGenerateSheet();
      syncDock();
      /* 状态行前面那枚转圈该收了。busy 此刻已经是 false,再刷一次就是清掉它。 */
      status(app.state.status);
    });
    app.events.on("results:changed", function () { refreshGenerateSheet(); });
    /* 作品有变化时只重画"正开着"的那一份。作品列表渲染在弹层内部的挂载点里
       (不是外面那个常驻容器 —— 弹层每次打开都会重写 innerHTML,
       常驻容器被搬进去之后会被下一次 openSheet 连带销毁,第二次打开就是空的)。 */
    app.events.on("works:changed", function () {
      if (app.components.ui.sheetOpen() && node("gallery-slot")) app.components.gallery.render();
    });
    /* 顶栏那行当前文档标题:只依赖 app.state.workTitle,而 work:changed 正是
       "当前作品换了一份"的统一出口 —— 改名也走它(见 store.updateWork 对当前作品
       那一支会调 applyToState),所以这里认一个事件就够。 */
    app.events.on("work:changed", syncWorkTitle);
  }

  function init() {
    app.i18n.apply();
    bindMenu();
    bindDock();
    bindTwistBar();
    bindPoseEvents();
    syncTwistBar();
    syncDock();
    var version = node("app-version");
    if (version) version.textContent = "v" + app.version;
    /* 先同步一次:此刻还没打开任何作品(openStartupWork 在自检之后才跑,见 app.js),
       这一步把标题块**确定地**收回,而不是把初始状态留给"一个也许会来的事件"。 */
    syncWorkTitle();
    return true;
  }

  app.features.editor = {
    init: init,
    status: status,
    defaultStatus: defaultStatus,
    syncWorkTitle: syncWorkTitle,
    syncDock: syncDock,
    /* 关节列表的折叠规则(读 / 写同一个函数,见它的注释)。导出是给
       tests/pick-fold.test.mjs 用的:这条规则只活在事件回调里的话,单测够不着。 */
    pickListFolded: pickListFolded,
    /* 面板画出来的那一段 HTML:折叠这件事全在那上面,而它只能靠替身面板跑一遍来验
       (真机验收另有一条)。见 tests/pick-fold.test.mjs。 */
    renderJointPanel: renderJointPanel,
    /* 成图网格那一段 HTML 与两个按钮的接线:见 tests/result-delete.test.mjs */
    renderResults: renderResults,
    removeResult: removeResult,
    openAddWorkSheet: openAddWorkSheet,
    captureStage: captureStage,
    openPoseSheet: openPoseSheet,
    openPickSheet: openPickSheet,
    openToolsSheet: openToolsSheet,
    openRenderSheet: openRenderSheet,
    openGenerateSheet: openGenerateSheet,
    openResultsSheet: openResultsSheet,
    openEditWorkSheet: openEditWorkSheet,
    /* 生成弹窗那三颗按钮的显隐/文案,以及"失败后可续取"那个入口。
       导出是给 tests/retrieve.test.mjs 用的 —— 这一格的坑在于底部按钮与内容区是
       **兄弟**,从内容区里查永远是 null 且不报错;所以那个函数**自己取根**、不收参数,
       断言也就落在"它取的那个根对不对"上。 */
    syncGenerateSheet: syncGenerateSheet,
    modelsBackTarget: modelsBackTarget,
    retrieveNow: retrieveNow,
    askRetrieve: askRetrieve
  };
})(window.posegi);
