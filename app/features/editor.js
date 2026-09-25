/* 页面装配:把界面按钮接到接口上
 *
 * 责任:绑定 DOM 事件、更新状态行、把错误变成提示。不承载业务规则。
 * 约定:所有可点元素都带 data-menu / data-pose / data-joint / data-action,便于 verify.mjs 断言。
 *
 * 界面结构:顶栏 + 全屏 3D 舞台 + 一排浮动按钮。剩下的工具(姿态、关节、生成)一律是
 * 底部 sheet —— 点按钮才出现,不占场景。所以这些面板的 DOM 都是"打开时才存在"的,
 * 各自的绑定写在 openSheet 的 onMount 里,而不是 init 里。
 */
(function (app) {
  "use strict";

  function node(id) { return document.getElementById(id); }

  function text(zh, en) { return app.i18n.text(zh, en); }

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

  /* 状态行末尾补一句"自转在哪调"。自转是拖拽够不到的那一个通道,不提示就等于没有。
     只补在状态行上,不补进关节面板里的同一句说明 —— 面板里那一行正好就有自转的滑杆,
     在那儿说"用底部滑杆"是自相矛盾。 */
  function twistHint() {
    return twistTarget() && !twistSuppressed ? text(",自转用底部滑杆", ", twist with the slider below") : "";
  }

  /* ---------- 菜单 ---------- */

  function bindMenu() {
    var button = node("open-menu");
    var menu = node("app-menu");
    if (!button || !menu) return;
    button.onclick = function () {
      var open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    menu.addEventListener("click", function (event) {
      var target = event.target.closest("[data-menu]");
      if (!target) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      var action = target.dataset.menu;
      if (action === "poses") openPoseSheet();
      if (action === "results") openResultsSheet();
      if (action === "models") app.components.settings.openModels();
      if (action === "preferences") app.components.settings.openPreferences();
      if (action === "help") openHelp();
      if (action === "about") openAbout();
    });
  }

  /* ---------- 底部 sheet:姿态 ---------- */

  function chipHtml(attributes, label) {
    return "<button class=\"chip\" " + attributes + ">" + label + "</button>";
  }

  function openPoseSheet() {
    var html = '<div class="sheet-row">';
    app.rig.presets.forEach(function (preset) {
      html += chipHtml('data-pose="' + preset.id + '"', text(preset.label[0], preset.label[1]));
    });
    html += "</div>";
    html += '<div class="sheet-row">';
    html += chipHtml('data-action="mirror"', text("左右镜像", "Mirror"));
    html += chipHtml('data-action="reset"', text("回到站姿", "Reset"));
    html += chipHtml('data-action="fit"', text("重新取景", "Fit"));
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
            status(text("已套用预设:", "Preset applied: ") + button.textContent);
          };
        });
        Array.prototype.forEach.call(content.querySelectorAll("[data-action]"), function (button) {
          button.onclick = function () {
            var action = button.dataset.action;
            if (action === "mirror") {
              app.features.poser.mirror();
              status(text("已左右镜像", "Pose mirrored"));
            } else if (action === "reset") {
              app.features.poser.reset();
              status(text("已回到默认站姿", "Back to the default stand"));
            } else if (action === "fit") {
              app.components.viewport.frameCamera();
              status(text("已重新取景", "Camera reframed"));
            }
          };
        });
      }
    });
  }

  /* ---------- 底部 sheet:关节 ---------- */

  /* 滑杆与姿态之间的两个方向。
   * 滑杆显示的是"**相对静止姿态转了多少**",写回去的是**绝对角度** —— 两边共用 rig 的那一对
   * 函数,才不会差一个 rest(脚踝的 rest 是 65 度、大腿的 rest z 是 -178.7 度,差起来很显眼)。
   * 行程取 rig.jointRange,也就是**该关节自己的解剖窗口**,不再是写死的 ±180:
   * 写死行程时旋钮能停在 180 而角度被夹在 20(小腿的自转窗口只有 ±20),那个不一致
   * 正是"旋钮与数值对不上"。 */
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

    if (!joint) {
      var picker = '<p class="joint-empty">' + text(
        "还没选中关节。在场景里点一下胳膊、腿或头,也可以从下面直接选:",
        "Nothing selected yet. Tap an arm, a leg or the head in the scene, or pick one below:"
      ) + "</p>";
      picker += '<div class="sheet-row">';
      PICK_ORDER.forEach(function (item) {
        picker += chipHtml('data-joint="' + item + '"', jointLabel(item));
      });
      picker += "</div>";
      panel.innerHTML = picker;
      Array.prototype.forEach.call(panel.querySelectorAll("[data-joint]"), function (button) {
        button.onclick = function () { app.features.poser.selectJoint(button.dataset.joint); };
      });
      return;
    }

    var html = '<div class="joint-head"><strong>' + jointLabel(name) + "</strong><code>" + name + "</code></div>";
    AXIS_LABEL.forEach(function (axis) {
      var range = app.rig.jointRange(name, axis.key);
      var delta = axisDelta(name, axis.key);
      html += '<div class="axis-row"><label>' + text(axis.zh, axis.en) + "</label>" +
        '<input type="range" min="' + range[0] + '" max="' + range[1] + '" step="1" data-axis="' +
        axis.key + '" value="' + delta + '"><output>' + signed(delta) + "°</output></div>";
    });
    html += '<p class="sheet-note">' + describeSelection(name, app.state.selectedPart) + "</p>";
    panel.innerHTML = html;

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

  function openJointSheet() {
    app.components.ui.openSheet({
      eyebrow: text("造型", "Pose"),
      title: text("关节", "Joint"),
      bodyHtml: '<div class="joint-panel" id="joint-panel"></div>',
      onMount: function () { renderJointPanel(app.state.selectedJoint); }
    });
  }

  /* ---------- 常驻自转滑杆 ---------- */

  /* 自转(绕骨轴拧)是唯一"拖拽永远碰不到"的自由度:转轴就是骨头自己的轴,
     而骨的末端就在这根轴上,转它在屏幕上几乎不动(实测自转通道只有最强通道的 1~5%,
     而视口解算的丢弃线是 55%,它在第一道过滤里就被扔掉)。所以它必须有独立控件。
     只在选中一个**窗口非空**的关节时出现;纯变换节点(broot)没有可转余地,不出现。 */
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
     双击成立时再放回去(viewport:blank-cancel);选中本身仍旧等那 320ms 的正式事件。
     这个开关只管滑杆的显隐,不碰姿态,也不碰选中。 */
  var twistSuppressed = false;

  function setTwistSuppressed(value) {
    twistSuppressed = value === true;
    syncTwistBar();
    /* 状态行那句",自转用底部滑杆"是滑杆的说明,滑杆走了它也得走 */
    status(describeSelection(app.state.selectedJoint, app.state.selectedPart) + twistHint());
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
    /* 标题行只讲"在拧哪个关节",轴名退成小字;范围数字下移到滑杆两侧。 */
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
    /* 右侧写"当前值/上限":上限同时就是刻度的右端,不必再单独画一个 */
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

  /* ---------- 底部 sheet:生成 ---------- */

  function openGenerateSheet() {
    var html = '<p class="sheet-note">' + text(
      "把当前造型渲染成一张图,再交给本地生图服务。画面描述与接口配置还没实现。",
      "Render the current pose to an image, then hand it to your local image service. The description and the service config are not implemented yet."
    ) + "</p>";
    html += '<div class="sheet-actions">' +
      '<button class="button button-primary" type="button" data-action="generate">' + text("生成", "Generate") + "</button>" +
      '<button class="button button-secondary" type="button" data-action="results">' + text("作品库", "Results") + "</button>" +
      "</div>";

    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: text("出图", "Render"),
      bodyHtml: html,
      onMount: function (content) {
        Array.prototype.forEach.call(content.querySelectorAll("[data-action]"), function (button) {
          button.onclick = function () {
            if (button.dataset.action === "results") { openResultsSheet(); return; }
            app.services.imageEngine.run().catch(function (error) {
              app.components.ui.toast(app.utils.cleanError(error), "error");
              status(app.utils.cleanError(error));
            });
          };
        });
      }
    });
  }

  function openResultsSheet() {
    var host = node("gallery-body");
    app.components.ui.openSheet({
      eyebrow: text("生成", "Generation"),
      title: text("作品库", "Results"),
      bodyHtml: '<div id="gallery-slot"></div>',
      onMount: function (content) {
        var slot = content.querySelector("#gallery-slot");
        if (!host || !slot) return;
        host.classList.add("is-mounted");
        slot.appendChild(host);
        app.components.gallery.init(host);
      }
    });
  }

  /* ---------- 浮动按钮 ---------- */

  function bindDock() {
    var poses = node("open-poses");
    if (poses) poses.onclick = openPoseSheet;

    var joint = node("open-joint");
    if (joint) joint.onclick = openJointSheet;

    var generate = node("open-generate");
    if (generate) generate.onclick = openGenerateSheet;

    var move = node("toggle-move");
    if (move) move.onclick = function () {
      var next = app.components.viewport.mode() === "move" ? "pose" : "move";
      app.components.viewport.setMode(next);
      move.classList.toggle("is-on", next === "move");
      status(next === "move"
        ? text("搬运模式:拖小人整体平移,姿态不变", "Move mode: drag the figure around, the pose stays as is")
        : defaultStatus());
    };

    var fit = node("frame-camera");
    if (fit) fit.onclick = function () {
      app.components.viewport.frameCamera();
      status(text("已重新取景", "Camera reframed"));
    };

    /* 正反着色:纯显示开关 —— 把"哪边是正面"变成肉眼可见的事实,不必再靠推理。
       黑白只按 30% 混进模型原本的材质颜色,所以明暗与体积感都还在;
       不碰姿态数据、不碰光照与场景(见 viewport 的 正反着色 一节)。 */
    var mask = node("toggle-mask");
    if (mask) mask.onclick = function () {
      var viewport = app.components.viewport;
      var on = viewport.setFrontBackMask(!viewport.frontBackMask());
      mask.classList.toggle("is-on", on);
      mask.setAttribute("aria-pressed", on ? "true" : "false");
      status(on
        ? text("正反着色:正面偏白、背面偏灰(30% 混合)", "Front/back tint: front toward white, back toward gray (30% mix)")
        : defaultStatus());
    };
  }

  /* 空白处双击:整个人回到画面正中、大小铺满舞台(与"重新取景"按钮同一件事)。
     **不动选择** —— 相机动作一律不改"正在摆哪个关节",双击回正也一样:
     之前这里顺手取消了选择,于是"双击把人摆正,选中的关节也跟着没了"(用户反馈)。
     顺带把相机的目标点复位到胯骨 —— 这是它除"平移"之外唯一会被改动的场合,
     见 viewport 的 视图导航 一节。 */
  function reframe() {
    app.components.viewport.frameCamera();
    status(text("已重新取景", "Camera reframed"));
  }

  /* ---------- 事件 ---------- */

  function bindPoseEvents() {
    app.events.on("pose:selected", function (detail) {
      twistSuppressed = false;   /* 换了选中目标,挂起态自动作废 */
      renderJointPanel(detail.joint);
      syncTwistBar();
      status(describeSelection(detail.joint, detail.part || app.state.selectedPart) + twistHint());
    });
    app.events.on("pose:changed", function () {
      syncJointPanel();
      syncTwistBar();
    });
    /* 点空白:挂起的那一刻先收起滑杆(手感立刻),双击成立时再放回去。
       这两条只动显隐,选中本身仍旧等 viewport:blank —— 见 viewport.js 的 scheduleBlank。 */
    app.events.on("viewport:blank-pending", function () { setTwistSuppressed(true); });
    app.events.on("viewport:blank-cancel", function () { setTwistSuppressed(false); });
    app.events.on("viewport:unavailable", function (detail) {
      status(detail.reason);
    });
    app.events.on("viewport:lost", function (detail) {
      status(detail.reason);
    });
    app.events.on("viewport:restored", function () {
      status(text("图形上下文已恢复", "Graphics context restored"));
    });
    app.events.on("viewport:reframe", reframe);
  }

  function openHelp() {
    app.components.ui.openSheet({
      eyebrow: text("说明", "Guide"),
      title: text("怎么用", "How it works"),
      bodyHtml: '<p class="sheet-note">' + text(
        "1. 拖连接杆(胳膊、腿、脖子)旋转那一节;2. 拖节点(头、膝、肘、手、脚)把它挪到手指的位置;3. 拖空白处转视角(镜头绕人物胯骨转),双指缩放;4. 双击空白处让整个人回到画面正中;5. 点搬运再拖小人,整体平移;6. 点生成出图。",
        "1. Drag a connector (arm, leg, neck) to rotate that segment. 2. Drag a joint (head, knee, elbow, hand, foot) to move it under your finger. 3. Drag the background to orbit the camera around the figure's hips, pinch to zoom. 4. Double-tap the background to bring the whole figure back to the centre. 5. Press Move to shift the whole figure. 6. Press Generate to render."
      ) + "</p>"
    });
  }

  function openAbout() {
    app.components.ui.openSheet({
      eyebrow: text("关于", "About"),
      title: "PoseGi " + app.version,
      bodyHtml: '<p class="sheet-note">' + text(
        "Hermit 上的 3D 摆姿 happ,手动摆放人形骨骼后交给本地大模型生图。MIT 许可。",
        "A 3D posing happ for Hermit: pose a humanoid rig by hand, then render it with a local image model. MIT licensed."
      ) + '</p><p class="sheet-note">github.com/zhyuzh3d/PoseGi</p>'
    });
  }

  function init() {
    app.i18n.apply();
    bindMenu();
    bindDock();
    bindTwistBar();
    bindPoseEvents();
    syncTwistBar();
    var version = node("app-version");
    if (version) version.textContent = "v" + app.version;
    return true;
  }

  app.features.editor = {
    init: init,
    status: status,
    defaultStatus: defaultStatus,
    openPoseSheet: openPoseSheet,
    openJointSheet: openJointSheet,
    openGenerateSheet: openGenerateSheet,
    openHelp: openHelp,
    openAbout: openAbout
  };
})(window.posegi);
