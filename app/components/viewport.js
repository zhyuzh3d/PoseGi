/* 3D 视口:场景、相机、程序化小人、命中检测、拖拽旋转、截图
 *
 * 责任:唯一接触 three.js 的模块。对外只暴露"放一个姿态进去、拿一张图出来"。
 *
 * 场景图(与 app/core/rig.js 的层级一一对应):
 *   scene → bbox(Group,人物子空间,可整体搬运) → broot → hips → spine / thigh.L / thigh.R → …
 *
 * 姿态数据到渲染的唯一桥梁是 applyPose():
 *   每个关节对象的局部矩阵直接由 app.rig.rotationMatrix() 拼出来,
 *   所以渲染结果与 rig.js 的前向运动学必然一致,不存在两套数学。
 *
 * 交互分层(与锁定模型一致):
 *   拖空白    → OrbitControls 转相机
 *   拖关节    → 绕该关节的屈伸轴 / 侧摆轴旋转(屏幕空间最小二乘,末端跟手)
 *   搬运模式  → 拖人 = 移动 bbox,整体平移,姿态一个字节都不改
 *
 * 事件(本模块不反向调用上层,由 app.js 装配):
 *   viewport:ready / unavailable / lost / restored
 *   viewport:picked  { joint }
 *   viewport:rotate  { joint, patch: { x, z } }
 *   viewport:body    { position: {x,y,z} }
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
  var BBOX_SIZE = { width: 1.0, height: 1.9, depth: 0.9, centerY: 0.95 };

  /* 场景配色跟页面主题走:深色页面里放一块浅底视口会非常刺眼 */
  var THEMES = {
    light: {
      background: 0xeef1f5, bone: 0xd9d4cb, joint: 0xc2bcb1, head: 0xe2ddd5, pivot: 0x7d8794,
      gridMain: 0xc3c8cf, gridSub: 0xe1e4e8, shadowColor: 0x1b2026, shadowOpacity: 0.09, boxLine: 0x534ab7
    },
    dark: {
      background: 0x1b1e23, bone: 0x8f8c85, joint: 0x77746e, head: 0x9d998f, pivot: 0x9aa6b4,
      gridMain: 0x3d444d, gridSub: 0x2b3037, shadowColor: 0x000000, shadowOpacity: 0.32, boxLine: 0xa9a2f2
    }
  };
  var themeName = "light";

  var state = {
    container: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    bbox: null,
    boxHelper: null,
    objects: {},
    parts: {},
    pickables: [],
    raycaster: null,
    pointer: null,
    assets: null,
    angles: null,
    selected: "",
    mode: "pose",
    dragging: null,
    available: false,
    reason: "",
    lost: false,
    frame: 0,
    observer: null,
    disposed: false
  };

  function rad(degree) { return degree * Math.PI / 180; }

  function text(zh, en) { return app.i18n.text(zh, en); }

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

  /* ---------- 资源:几何体与材质,所有关节共用 ---------- */

  function buildAssets() {
    var palette = THEMES[themeName];
    var boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false);
    var jointGeometry = new THREE.SphereGeometry(1, 16, 12);
    var headGeometry = new THREE.SphereGeometry(1, 22, 16);
    var pivotGeometry = THREE.OctahedronGeometry ? new THREE.OctahedronGeometry(1, 0) : new THREE.SphereGeometry(1, 8, 6);

    state.assets = {
      geometries: {
        bone: boneGeometry,
        joint: jointGeometry,
        head: headGeometry,
        pivot: pivotGeometry
      },
      materials: {
        bone: new THREE.MeshStandardMaterial({ color: palette.bone, roughness: 0.62, metalness: 0.02 }),
        joint: new THREE.MeshStandardMaterial({ color: palette.joint, roughness: 0.7, metalness: 0.02 }),
        head: new THREE.MeshStandardMaterial({ color: palette.head, roughness: 0.55, metalness: 0.02 }),
        pivot: new THREE.MeshStandardMaterial({ color: palette.pivot, roughness: 0.5, metalness: 0.1 }),
        selected: new THREE.MeshStandardMaterial({ color: 0x2f6bff, roughness: 0.42, metalness: 0.08 }),
        boxLine: new THREE.LineBasicMaterial({ color: palette.boxLine, transparent: true, opacity: 0.6 }),
        shadow: new THREE.MeshBasicMaterial({ color: palette.shadowColor, transparent: true, opacity: palette.shadowOpacity })
      }
    };
    return state.assets;
  }

  /* 换主题只改颜色,不重建场景:几何体与骨架对象都还在,改色即可。
     例外是 GridHelper —— 它的颜色烘在顶点色缓冲里,必须重建才能换色。 */
  function paintTheme() {
    if (!state.assets) return;
    var palette = THEMES[themeName] || THEMES.light;
    var materials = state.assets.materials;
    materials.bone.color.setHex(palette.bone);
    materials.joint.color.setHex(palette.joint);
    materials.head.color.setHex(palette.head);
    materials.pivot.color.setHex(palette.pivot);
    materials.boxLine.color.setHex(palette.boxLine);
    materials.shadow.color.setHex(palette.shadowColor);
    materials.shadow.opacity = palette.shadowOpacity;
    if (state.scene && state.scene.background && state.scene.background.setHex) state.scene.background.setHex(palette.background);
    if (state.renderer) state.renderer.setClearColor(palette.background, 1);

    if (state.scene) {
      if (state.grid) {
        state.scene.remove(state.grid);
        state.grid.geometry.dispose();
        state.grid.material.dispose();
      }
      var grid = new THREE.GridHelper(4, 8, new THREE.Color(palette.gridMain), new THREE.Color(palette.gridSub));
      grid.material.transparent = true;
      grid.material.opacity = 0.9;
      state.scene.add(grid);
      state.grid = grid;
    }
    highlight(state.selected);
  }

  function disposeAssets() {
    if (!state.assets) return;
    Object.keys(state.assets.geometries).forEach(function (key) { state.assets.geometries[key].dispose(); });
    ["bone", "joint", "head", "pivot", "selected", "boxLine", "shadow"].forEach(function (key) {
      var material = state.assets.materials[key];
      if (material && material.dispose) material.dispose();
    });
    state.assets = null;
  }

  /* ---------- 场景与骨架 ---------- */

  function buildScene() {
    var palette = THEMES[themeName];
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(palette.background);
    state.scene = scene;

    var width = Math.max(1, state.container.clientWidth);
    var height = Math.max(1, state.container.clientHeight);
    var camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 60);
    camera.position.set(0.62, 1.28, 2.45);
    camera.lookAt(0, 0.92, 0);
    state.camera = camera;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa9b2bd, 0.95));
    var key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1.8, 3.2, 2.4);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xdce6f2, 0.3);
    fill.position.set(-2.1, 1.6, -1.5);
    scene.add(fill);

    var grid = new THREE.GridHelper(4, 8, state.assets.materials.gridMain, state.assets.materials.gridSub);
    grid.material.transparent = true;
    grid.material.opacity = 0.9;
    scene.add(grid);
    state.grid = grid;

    var shadow = new THREE.Mesh(new THREE.CircleGeometry(0.28, 24), state.assets.materials.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    scene.add(shadow);
    state.shadow = shadow;

    /* bbox:人物所在的子空间。"搬运"移动的就是它,姿态不受影响。 */
    var bbox = new THREE.Group();
    scene.add(bbox);
    state.bbox = bbox;

    var edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(BBOX_SIZE.width, BBOX_SIZE.height, BBOX_SIZE.depth));
    var helper = new THREE.LineSegments(edges, state.assets.materials.boxLine);
    helper.position.y = BBOX_SIZE.centerY;
    helper.visible = false;
    bbox.add(helper);

    state.boxHelper = { object: helper, geometry: edges };
    paintTheme();
    return scene;
  }

  function buildRig() {
    state.objects = {};
    state.parts = {};
    state.pickables = [];

    app.rig.joints.forEach(function (joint) {
      var object = new THREE.Object3D();
      object.name = "joint:" + joint.name;
      object.matrixAutoUpdate = false;
      var parent = joint.parent ? state.objects[joint.parent] : null;
      (parent || state.bbox).add(object);
      state.objects[joint.name] = object;

      var parts = { bone: null, cap: null };

      if (joint.pivot) {
        var marker = new THREE.Mesh(state.assets.geometries.pivot, state.assets.materials.pivot);
        marker.scale.setScalar(0.055);
        marker.userData.joint = joint.name;
        object.add(marker);
        parts.cap = marker;
        state.pickables.push(marker);
      } else if (joint.name === HEAD_JOINT) {
        var head = new THREE.Mesh(state.assets.geometries.head, state.assets.materials.head);
        head.scale.setScalar(0.112);
        head.position.y = joint.length * 0.55;
        head.userData.joint = joint.name;
        object.add(head);
        parts.cap = head;
        state.pickables.push(head);
      } else {
        var shape = joint.shape;
        var bone = new THREE.Mesh(state.assets.geometries.bone, state.assets.materials.bone);
        bone.scale.set(joint.radius * (shape ? shape.sx : 1), joint.length, joint.radius * (shape ? shape.sz : 1));
        bone.position.y = joint.length / 2;
        bone.userData.joint = joint.name;
        object.add(bone);
        parts.bone = bone;
        state.pickables.push(bone);

        var cap = new THREE.Mesh(state.assets.geometries.joint, state.assets.materials.joint);
        cap.scale.setScalar(joint.radius * 1.04);
        cap.userData.joint = joint.name;
        object.add(cap);
        parts.cap = cap;
        state.pickables.push(cap);
      }

      state.parts[joint.name] = parts;
    });

    state.bbox.updateMatrixWorld(true);
  }

  /* ---------- 姿态 ---------- */

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
    return pose;
  }

  function highlight(name) {
    state.selected = app.rig.byName(name) ? String(name) : "";
    app.rig.joints.forEach(function (joint) {
      var parts = state.parts[joint.name];
      if (!parts) return;
      var on = joint.name === state.selected;
      var isHead = joint.name === HEAD_JOINT;
      if (parts.bone) parts.bone.material = on ? state.assets.materials.selected : state.assets.materials.bone;
      if (parts.cap) {
        var normal = joint.pivot ? state.assets.materials.pivot : (isHead ? state.assets.materials.head : state.assets.materials.joint);
        parts.cap.material = on ? state.assets.materials.selected : normal;
      }
    });
  }

  /* ---------- 屏幕空间辅助 ---------- */

  function toScreen(vector) {
    var point = vector.clone().project(state.camera);
    return {
      x: (point.x * 0.5 + 0.5) * state.canvas.clientWidth,
      y: (-point.y * 0.5 + 0.5) * state.canvas.clientHeight
    };
  }

  function jointWorld(name, offsetVector) {
    var object = state.objects[name];
    if (!object) return null;
    return offsetVector.clone().applyMatrix4(object.matrixWorld);
  }

  /* 关节末端在世界空间的位置(枢轴节点没有骨骼,借一段虚拟半径当把手) */
  function jointReach(name) {
    var joint = app.rig.byName(name);
    var length = joint.pivot ? 0.42 : joint.length;
    if (joint.name === HEAD_JOINT) length = 0.16;
    return jointWorld(name, new THREE.Vector3(0, length, 0));
  }

  /* 绕某个欧拉通道转 1 弧度时,关节末端在屏幕上走多远(像素)。
     推导:局部旋转矩阵 R = Rz·Ry·Rx,所以
       ∂R/∂x 的转轴是 Rz·Ry·e_x,∂R/∂y 的是 Rz·e_y,∂R/∂z 的就是 e_z(都在父坐标系里)。 */
  function axisScreenMotion(name, key) {
    var joint = app.rig.byName(name);
    var angle = state.angles[name];
    var object = state.objects[name];
    var parentWorld = object.parent ? object.parent.matrixWorld : new THREE.Matrix4();
    var parentQuaternion = new THREE.Quaternion().setFromRotationMatrix(parentWorld);

    var axis;
    if (key === "x") {
      axis = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad(angle.z))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad(angle.y)))
      );
    } else if (key === "y") {
      axis = new THREE.Vector3(0, 1, 0).applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad(angle.z))
      );
    } else {
      axis = new THREE.Vector3(0, 0, 1);
    }
    axis.applyQuaternion(parentQuaternion).normalize();

    var origin = jointWorld(name, new THREE.Vector3(0, 0, 0));
    var reach = jointReach(name);
    var radius = reach.clone().sub(origin);
    var motion = new THREE.Vector3().crossVectors(axis, radius);

    var from = toScreen(reach);
    var to = toScreen(reach.clone().add(motion));
    return { x: to.x - from.x, y: to.y - from.y };
  }

  /* ---------- 命中检测 ---------- */

  function pick(clientX, clientY) {
    if (!state.available || state.lost || !state.canvas) return "";
    var rect = state.canvas.getBoundingClientRect();
    var width = Math.max(1, rect.width);
    var height = Math.max(1, rect.height);
    state.pointer.x = ((clientX - rect.left) / width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);

    var hits = state.raycaster.intersectObjects(state.pickables, false);
    if (hits.length) {
      var name = hits[0].object.userData.joint;
      if (name) return name;
    }
    return pickByDistance(clientX, clientY);
  }

  /* 手机上骨骼很细,射线容易打空。退回"离关节最近且在容差内"的判定。 */
  function pickByDistance(clientX, clientY) {
    var rect = state.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var tolerance = 30;
    var best = "";
    var bestDistance = tolerance;
    app.rig.joints.forEach(function (joint) {
      var object = state.objects[joint.name];
      if (!object) return;
      var screen = toScreen(object.getWorldPosition(new THREE.Vector3()));
      var distance = Math.sqrt((screen.x - x) * (screen.x - x) + (screen.y - y) * (screen.y - y));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = joint.name;
      }
    });
    return best;
  }

  /* ---------- 拖拽 ---------- */

  function rotateJoint(name, dx, dy) {
    var joint = app.rig.byName(name);
    if (!joint || !state.angles) return 0;
    var angle = state.angles[name];
    var motionX = axisScreenMotion(name, "x");
    var motionZ = axisScreenMotion(name, "z");

    var determinant = motionX.x * motionZ.y - motionZ.x * motionX.y;
    var turnX = 0;
    var turnZ = 0;

    if (Math.abs(determinant) > 4) {
      turnX = (dx * motionZ.y - motionZ.x * dy) / determinant;
      turnZ = (motionX.x * dy - dx * motionX.y) / determinant;
    } else {
      /* 两个轴在屏幕上几乎重合(正对着骨骼看),只挑走得动的那个用 */
      var useX = motionX.x * motionX.x + motionX.y * motionX.y >= motionZ.x * motionZ.x + motionZ.y * motionZ.y;
      if (useX) turnX = (dx * motionX.x + dy * motionX.y) / Math.max(1, motionX.x * motionX.x + motionX.y * motionX.y);
      else turnZ = (dx * motionZ.x + dy * motionZ.y) / Math.max(1, motionZ.x * motionZ.x + motionZ.y * motionZ.y);
    }

    var limit = rad(22);
    turnX = Math.max(-limit, Math.min(limit, turnX));
    turnZ = Math.max(-limit, Math.min(limit, turnZ));
    if (Math.abs(turnX) < 1e-4 && Math.abs(turnZ) < 1e-4) return 0;

    app.events.emit("viewport:rotate", {
      joint: name,
      patch: { x: angle.x + turnX * 180 / Math.PI, z: angle.z + turnZ * 180 / Math.PI }
    });
    return turnX * turnX + turnZ * turnZ;
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

  function onPointerDown(event) {
    if (!state.available || state.lost) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    var name = pick(event.clientX, event.clientY);

    if (state.mode === "move") {
      if (!name) return;
      event.stopPropagation();
      state.dragging = { kind: "body", x: event.clientX, y: event.clientY };
      return;
    }

    if (!name) return;
    event.stopPropagation();
    app.events.emit("viewport:picked", { joint: name });
    state.dragging = { kind: "joint", joint: name, x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event) {
    if (!state.dragging) return;
    var dx = event.clientX - state.dragging.x;
    var dy = event.clientY - state.dragging.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    if (state.dragging.kind === "body") moveBody(dx, dy);
    else rotateJoint(state.dragging.joint, dx, dy);
    state.dragging.x = event.clientX;
    state.dragging.y = event.clientY;
    if (event.cancelable) event.preventDefault();
  }

  function onPointerUp() { state.dragging = null; }

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
    buildAssets();
    buildScene();
    buildRig();
    applyPose(state.angles || app.rig.defaultAngles());
    highlight(state.selected);
    resize();
    app.events.emit("viewport:ready", { rebuilt: true });
  }

  function disposeSceneContents() {
    if (state.scene) {
      state.scene.traverse(function (object) {
        if (object.isMesh || object.isLine || object.isLineSegments || object.isPoints) {
          if (object.geometry && object.geometry.dispose) object.geometry.dispose();
        }
      });
    }
    if (state.boxHelper && state.boxHelper.geometry) state.boxHelper.geometry.dispose();
    state.boxHelper = null;
    state.grid = null;
    state.shadow = null;
    state.scene = null;
    state.camera = null;
    state.bbox = null;
    state.controls = null;
    state.objects = {};
    state.parts = {};
    state.pickables = [];
  }

  /* ---------- 渲染循环 ---------- */

  function tick() {
    if (state.disposed) return;
    state.frame = window.requestAnimationFrame(tick);
    if (!state.available || state.lost || !state.renderer || document.hidden) return;
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
      renderer.setClearColor(0xeef1f5, 1);
      if ("outputEncoding" in renderer && THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
      state.renderer = renderer;

      state.raycaster = new THREE.Raycaster();
      state.pointer = new THREE.Vector2();

      /* 先挂捕获阶段的指针监听,再建 OrbitControls:
         命中关节时 stopPropagation,事件根本到不了画布,轨道旋转自然让位给关节拖拽。 */
      state.container.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("webglcontextlost", onContextLost, false);
      canvas.addEventListener("webglcontextrestored", onContextRestored, false);

      rebuild();
      hideFallback();

      state.controls = new THREE.OrbitControls(state.camera, canvas);
      state.controls.target.set(0, 0.92, 0);
      state.controls.enableDamping = true;
      state.controls.dampingFactor = 0.12;
      state.controls.rotateSpeed = 0.85;
      state.controls.zoomSpeed = 0.9;
      state.controls.minDistance = 0.7;
      state.controls.maxDistance = 9;
      state.controls.maxPolarAngle = Math.PI * 0.495;
      state.controls.update();

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

  function setSelectedJoint(name) { highlight(name); }

  function setMode(mode) {
    state.mode = mode === "move" ? "move" : "pose";
    if (state.boxHelper) state.boxHelper.object.visible = state.mode === "move";
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

  function frameCamera() {
    if (!state.camera || !state.controls) return;
    var box = new THREE.Box3();
    app.rig.joints.forEach(function (joint) {
      var object = state.objects[joint.name];
      if (object) box.expandByPoint(object.getWorldPosition(new THREE.Vector3()));
    });
    if (box.isEmpty()) return;
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var radius = Math.max(size.x, size.y, size.z) * 0.6 + 0.4;
    var distance = radius / Math.tan(state.camera.fov * Math.PI / 360);
    var direction = state.camera.position.clone().sub(state.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.3, 0.4, 1);
    direction.normalize();
    state.controls.target.copy(center);
    state.camera.position.copy(center).addScaledVector(direction, distance);
    state.controls.update();
  }

  function renderFrame() {
    state.renderer.render(state.scene, state.camera);
  }

  function capture() {
    if (!state.available || state.lost || !state.renderer) throw new Error(text("3D 视口不可用,无法截图", "The 3D viewport is unavailable, so it cannot be captured"));
    state.renderer.render(state.scene, state.camera);
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
  function captureAt(width, height) {
    if (!state.available || state.lost || !state.renderer) throw new Error(text("3D 视口不可用,无法截图", "The 3D viewport is unavailable, so it cannot be captured"));
    var targetWidth = Math.max(64, Math.round(Number(width) || 768));
    var targetHeight = Math.max(64, Math.round(Number(height) || 1024));
    var restoreWidth = state.container.clientWidth;
    var restoreHeight = state.container.clientHeight;
    var restoreAspect = state.camera.aspect;

    state.renderer.setPixelRatio(1);
    state.renderer.setSize(targetWidth, targetHeight, false);
    state.camera.aspect = targetWidth / targetHeight;
    state.camera.updateProjectionMatrix();
    renderFrame();
    var dataUrl = state.canvas.toDataURL("image/png");

    state.camera.aspect = restoreAspect;
    state.camera.updateProjectionMatrix();
    resize();
    renderFrame();

    return {
      dataUrl: dataUrl,
      imageBase64: dataUrl.replace(/^data:[^,]+,/, ""),
      mime: "image/png",
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

  function counts() {
    return {
      joints: app.rig.joints.length,
      meshes: state.pickables.length,
      drawCalls: state.renderer ? state.renderer.info.render.calls : 0
    };
  }

  function dispose() {
    state.disposed = true;
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
    setTheme: function (name) {
      themeName = name === "dark" ? "dark" : "light";
      paintTheme();
      return themeName;
    },
    theme: function () { return themeName; },
    body: body,
    resetBody: resetBody,
    pick: pick,
    capture: capture,
    captureAt: captureAt,
    frameCamera: frameCamera,
    view: view,
    counts: counts,
    render: function () { if (state.available && !state.lost) renderFrame(); },
    dispose: dispose
  };
})(window.posegi);
