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
 *   工具  = 搬运 / 左右镜像 / 相机归位(原来的「搬运」,并把取景按钮收进来)
 *   渲染  = 正反着色三档(原来的「正反」)   生成 = 出图
 */
(function (app) {
  "use strict";

  function node(id) { return document.getElementById(id); }
  function text(zh, en) { return app.i18n.text(zh, en); }
  function esc(value) { return app.utils.escapeHtml(value); }

  function status(message) {
    app.state.status = String(message || "");
    var line = node("status-line");
    if (line) line.textContent = app.state.status;
    return app.state.status;
  }

  function defaultStatus() {
    return text("拖连接杆旋转,拖节点移动;拖空白处转视角,双击空白回正", "Drag a bone to rotate, a joint to move it; drag the background to orbit, double-tap to reframe");
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
   * 与生图那张参考图不是一回事:那张固定 1024 正方、JPEG、只为喂模型;
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

    html += '<div class="sheet-divider"></div><div class="pick-grid">';
    PICK_ORDER.forEach(function (item) {
      var on = item === name ? " is-on" : "";
      html += '<button class="pick-tile' + on + '" data-joint="' + esc(item) + '">' + esc(jointLabel(item)) + "</button>";
    });
    html += "</div>";
    panel.innerHTML = html;

    Array.prototype.forEach.call(panel.querySelectorAll("[data-walk]"), function (button) {
      button.onclick = function () { walk(button.dataset.walk); };
    });
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

  function openToolsSheet() {
    var moving = app.components.viewport.mode() === "move";
    var html =
      '<div class="tool-group"><span class="section-label">' + text("工具", "Tools") + "</span>" +
      '<button class="tool-row' + (moving ? " is-on" : "") + '" data-action="move"><i class="fa-solid fa-hand" aria-hidden="true"></i>' +
      '<span><strong>' + text("搬运", "Move") + "</strong><small>" +
      text("拖着整个人走,姿态一点不变", "Drag the whole figure; the pose stays exactly as it is") + "</small></span></button></div>" +
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
            var action = button.dataset.action;
            if (action === "move") {
              var viewport = app.components.viewport;
              var next = viewport.mode() === "move" ? "pose" : "move";
              viewport.setMode(next);
              button.classList.toggle("is-on", next === "move");
              syncDock();
              status(next === "move"
                ? text("搬运模式:拖小人整体平移,姿态不变", "Move mode: drag the figure around, the pose stays as is")
                : defaultStatus());
              return;
            }
            if (action === "mirror") {
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

  /* ---------- 底部 sheet:渲染(正反着色) ---------- */

  /* 三个档位改为横向 tab 组(2026-09-25 用户要求)。
     两处都从同一个 MODE_INFO 派生:tab 上写短名、下面写这一档到底做了什么 ——
     以前三行 list 每行自带图标与说明,横过来之后放不下,只能拆成"选择"与"解释"两层。 */
  var MASK_MODES = [
    { value: 0, icon: "fa-solid fa-circle-half-stroke", zh: "无", en: "Off",
      zhHint: "显示模型原本的材质颜色", enHint: "Show the model's own material colours" },
    { value: 1, icon: "fa-solid fa-adjust", zh: "正反黑白", en: "Grey",
      zhHint: "正面偏白、背面偏灰,30% 混合", enHint: "Front toward white, back toward grey, 30% mix" },
    { value: 2, icon: "fa-solid fa-adjust", zh: "正反红绿", en: "Red-green", dangerous: true,
      zhHint: "正面偏红、背面偏绿,30% 混合", enHint: "Front toward red, back toward green, 30% mix" }
  ];

  function maskInfo(mode) {
    return MASK_MODES.filter(function (item) { return item.value === Number(mode); })[0] || MASK_MODES[0];
  }

  function maskLabel(mode) {
    var info = maskInfo(mode);
    return text(info.zh, info.en);
  }

  function openRenderSheet() {
    var mode = Number(app.components.viewport.maskMode()) || 0;
    var tabs = '<div class="tab-row" role="tablist">' + MASK_MODES.map(function (item) {
      return '<button type="button" role="tab" class="tab-button' + (item.value === mode ? " is-on" : "") +
        '" data-mode="' + item.value + '" aria-selected="' + (item.value === mode ? "true" : "false") + '">' +
        '<i class="' + item.icon + (item.dangerous ? " is-danger" : "") + '" aria-hidden="true"></i>' +
        esc(text(item.zh, item.en)) + "</button>";
    }).join("") + "</div>";

    function hintHtml(value) {
      var info = maskInfo(value);
      return '<p class="tab-hint">' + esc(text(info.zhHint, info.enHint)) + "</p>";
    }

    app.components.ui.openSheet({
      eyebrow: text("检查", "Inspect"),
      title: text("渲染", "Render"),
      bodyHtml: tabs + '<div id="mask-hint">' + hintHtml(mode) + "</div>" +
        '<p class="sheet-note">' + text("只改变显示,不改变姿态,也不会进成图。",
          "This only changes the display. It never changes the pose and never reaches the generated image.") + "</p>",
      onMount: function (content) {
        var hint = content.querySelector("#mask-hint");
        Array.prototype.forEach.call(content.querySelectorAll("[data-mode]"), function (button) {
          button.onclick = function () {
            var next = Number(button.dataset.mode);
            app.components.viewport.setFrontBackMask(next);
            Array.prototype.forEach.call(content.querySelectorAll("[data-mode]"), function (item) {
              var on = Number(item.dataset.mode) === next;
              item.classList.toggle("is-on", on);
              item.setAttribute("aria-selected", on ? "true" : "false");
            });
            if (hint) hint.innerHTML = hintHtml(next);
            syncDock();
            if (next === 0) status(defaultStatus());
            else status(text("正反着色:", "Front/back tint: ") + maskLabel(next));
          };
        });
      }
    });
  }

  /* ---------- 底部 sheet:生成 ---------- */

  function resultItem(id) {
    return (app.state.results || []).filter(function (item) { return item.id === id; })[0] || null;
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
      return '<button class="result-thumb" data-result="' + esc(item.id) + '" type="button">' +
        '<img src="' + esc(item.src) + '" alt="' + esc(item.prompt) + '">' +
        '<span class="result-time">' + esc(app.utils.formatTime(item.createdAt)) + "</span></button>";
    }).join("");
    Array.prototype.forEach.call(grid.querySelectorAll("[data-result]"), function (button) {
      button.onclick = function () {
        var item = resultItem(button.dataset.result);
        if (item) app.components.renderPreview.open(item);
      };
    });
  }

  function renderCount(content) {
    var node2 = content.querySelector("#result-count");
    if (!node2) return;
    var max = Number(app.config && app.config.maxResults) || 12;
    node2.textContent = (app.state.results || []).length + "/" + max + " " + text("张", "images");
  }

  /* 生成中 / 空闲两副面孔都由这里刷:标题、按钮文案、取消按钮的显隐、
     以及外面那颗按钮的"黑色"状态。只有一处判断,界面不会自相矛盾。 */
  function syncGenerateSheet(content) {
    if (!content) return;
    var busy = app.services.imageEngine.busy();
    var generate = content.querySelector("[data-generate]");
    var cancel = content.querySelector("[data-cancel-generate]");
    if (generate) {
      generate.disabled = busy;
      generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>' +
        (busy ? text("渲染中", "Rendering") : text("立即生成新图", "Generate a new image"));
    }
    if (cancel) cancel.hidden = !busy;
    content.setAttribute("data-busy", busy ? "true" : "false");
    syncDock();
  }

  /* 描述区下面那一块:只有"这张卡只要英文"而且用户真写了中文时才出现。
     已经翻过的直接摆译文(同一句话不会再翻第二次),没翻过就给一个按钮。
     译文紧跟在输入框下面 —— 它讲的就是上面那句,挪到别处又得回头对一遍。 */
  function translateSlotHtml() {
    var model = app.services.providers.active();
    if (!model || model.needsEnglish !== true) return "";
    var prompt = String(app.state.prompt || "");
    if (!app.services.translate.hasCjk(prompt)) return "";
    var english = app.services.translate.english(prompt);
    if (english && english !== prompt) {
      return '<div class="translate-block"><span class="section-label">' + text("英文译文", "English") + "</span>" +
        '<p class="translate-text">' + esc(english) + "</p></div>";
    }
    return '<button class="button button-secondary button-block" type="button" data-translate-now>' +
      '<i class="fa-solid fa-language" aria-hidden="true"></i>' + text("翻译成英文", "Translate to English") + "</button>";
  }

  function openGenerateSheet() {
    var html = '<div class="result-head"><span class="section-label">' + text("历史成图", "History") + "</span>" +
      '<span class="result-count" id="result-count"></span></div>' +
      '<div class="result-grid" id="result-grid"></div>' +
      '<label class="field"><span>' + text("角色描述", "Description") + "</span>" +
      '<textarea name="prompt" rows="3" placeholder="' + esc(text("可以留空;例如:一个女孩站在海边,傍晚的光", "Optional — for example: a girl standing by the sea at dusk")) + '">' +
      esc(app.state.prompt) + "</textarea></label>" +
      '<div id="translate-slot"></div>';

    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: app.state.workTitle || text("出图", "Render"),
      bodyHtml: html,
      footerHtml: '<button class="button button-primary button-block" data-generate type="button">' +
        text("立即生成新图", "Generate a new image") + '</button>' +
        /* 图标按钮只吃图标自己那么宽,不去和主按钮抢那一行。
           它进的是模型列表,关掉还会回到这个弹窗(见 openModels 的 back)。 */
        '<button class="button button-secondary button-icon" data-model-list type="button" aria-label="' +
        esc(text("模型列表", "Model list")) + '"><i class="fa-solid fa-cubes" aria-hidden="true"></i></button>' +
        '<button class="button button-secondary" data-cancel-generate type="button" hidden>' + text("取消", "Cancel") + "</button>",
      onMount: function (content, actions) {
        renderResults(content);
        renderCount(content);
        syncGenerateSheet(content);
        var prompt = content.querySelector('[name="prompt"]');
        var slot = content.querySelector("#translate-slot");

        function paintSlot() {
          if (!slot) return;
          slot.innerHTML = translateSlotHtml();
          var button = slot.querySelector("[data-translate-now]");
          if (button) button.onclick = app.components.ui.action(translateNow);
        }

        /* 没配好翻译服务时,先把用户送到该去的地方再说话 ——
           只说"去配置"而不带路,等于让他自己找。 */
        async function translateNow() {
          var value = String(app.state.prompt || "");
          if (!app.services.translate.ready()) {
            app.components.ui.toast(text("还没有可用的翻译模型,先添加一个",
              "No translation model yet — add one first"));
            app.components.settings.openPreferences({ back: "generate" });
            return;
          }
          await app.services.translate.translate([value]);
          app.state.promptEn = app.services.translate.pair(value, "");
          app.services.store.scheduleSave();
          paintSlot();
        }
        paintSlot();

        if (prompt) prompt.oninput = function () {
          app.state.prompt = prompt.value;
          app.services.store.scheduleSave();
          paintSlot();
        };
        actions.querySelector("[data-generate]").onclick = app.components.ui.action(async function () {
          syncGenerateSheet(content);
          await app.services.imageEngine.run();
        });
        actions.querySelector("[data-cancel-generate]").onclick = function () {
          app.services.imageEngine.cancel();
          status(text("已取消等待这次生成", "Stopped waiting for this generation"));
        };
        actions.querySelector("[data-model-list]").onclick = function () {
          app.components.settings.openModels({ back: "generate" });
        };
      }
    });
  }

  /* 打开着生成弹窗时,成图一有变化就重画那两块;弹窗关着就什么都不做 */
  function refreshGenerateSheet() {
    var content = node("modal-content");
    if (!content || !content.querySelector("#result-grid")) return;
    renderResults(content);
    renderCount(content);
    syncGenerateSheet(content);
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

  /* ---------- 浮动按钮 ---------- */

  /* 底部按钮的"开着"状态集中刷:搬运模式、正反档位、生成中。
     三处各改一次类名,迟早有一处忘了同步(比如搬运开着却看不出)。 */
  function syncDock() {
    var viewport = app.components.viewport;
    var move = node("toggle-move");
    if (move) move.classList.toggle("is-on", viewport.mode() === "move");
    var render = node("toggle-render");
    if (render) render.classList.toggle("is-on", viewport.maskMode() > 0);
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

    /* 生图:进度走状态行,结果刷新生成弹窗,失败弹提示 */
    app.events.on("generation:start", function () {
      syncDock();
      syncGenerateSheet(node("modal-content"));
      status(text("开始生成…", "Generating…"));
    });
    app.events.on("generation:progress", function (detail) {
      if (detail && detail.detail) status(detail.detail);
    });
    app.events.on("generation:done", function () {
      refreshGenerateSheet();
      status(text("生成完成", "Generated"));
    });
    app.events.on("generation:error", function (detail) {
      refreshGenerateSheet();
      status(app.utils.cleanError(detail && detail.error));
    });
    app.events.on("generation:idle", function () {
      refreshGenerateSheet();
      syncDock();
    });
    app.events.on("results:changed", function () { refreshGenerateSheet(); });
    /* 作品有变化时只重画"正开着"的那一份。作品列表渲染在弹层内部的挂载点里
       (不是外面那个常驻容器 —— 弹层每次打开都会重写 innerHTML,
       常驻容器被搬进去之后会被下一次 openSheet 连带销毁,第二次打开就是空的)。 */
    app.events.on("works:changed", function () {
      if (app.components.ui.sheetOpen() && node("gallery-slot")) app.components.gallery.render();
    });
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
    return true;
  }

  app.features.editor = {
    init: init,
    status: status,
    defaultStatus: defaultStatus,
    syncDock: syncDock,
    openAddWorkSheet: openAddWorkSheet,
    captureStage: captureStage,
    openPoseSheet: openPoseSheet,
    openPickSheet: openPickSheet,
    openToolsSheet: openToolsSheet,
    openRenderSheet: openRenderSheet,
    openGenerateSheet: openGenerateSheet,
    openResultsSheet: openResultsSheet
  };
})(window.posegi);
