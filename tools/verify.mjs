/* PoseGi 静态检查与纯逻辑测试
 *
 * 检查项:
 *   1. 清单:haminn.json 的 schema、happId、版本号
 *   2. 引用:index.html 里的每个本地引用都存在,且没有远程依赖
 *   3. 顺序:脚本加载顺序符合分层依赖
 *   4. 语法:禁用 ES Modules 与新语法;每个 js 过一遍 node --check
 *   5. 契约:跨模块"调用了但没导出"的检查
 *   6. 测试:tests/ 下的纯逻辑测试
 *
 * 用法:node tools/verify.mjs [--source-only]
 *   --source-only 跳过发布包校验(日常改动用这个)
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOnly = process.argv.includes("--source-only");

/* 1. 清单 */
const manifest = JSON.parse(fs.readFileSync(path.join(root, "haminn.json"), "utf8"));
assert.equal(manifest.schema, 2);
assert.equal(manifest.happId, "life.airen.posegi");
assert.ok(Number.isInteger(manifest.version.code) && manifest.version.code > 0, "版本 code 必须是正整数");
assert.match(manifest.version.name, /^\d+\.\d+\.\d+$/, "版本名必须是 x.y.z");
assert.equal(manifest.entry, "index.html");
assert.equal(manifest.display.orientation, "portrait");
assert.ok(fs.existsSync(path.join(root, manifest.icon)), `清单里的图标不存在:${manifest.icon}`);

/* 2. 引用与远程依赖 */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
for (const reference of references) {
  if (reference.startsWith("/__haminn/") || reference.startsWith("data:")) continue;
  assert.ok(!/^https?:/i.test(reference), `运行包不得引用远程资源:${reference}`);
  assert.ok(fs.existsSync(path.join(root, reference.replace(/^\.\//, ""))), `引用不存在:${reference}`);
}

/* 3. 脚本顺序 */
const scripts = references.filter((value) => value.endsWith(".js")).map((value) => value.replace(/^\.\//, ""));
assert.ok(scripts.length >= 15, "入口应当加载全部运行时脚本");
assert.equal(scripts[0], "vendor/three/three.min.js", "three.js 必须最先加载");
assert.equal(scripts.at(-1), "app/app.js", "app.js 必须最后加载");
const before = (early, late) => assert.ok(scripts.indexOf(early) < scripts.indexOf(late), `${early} 必须在 ${late} 之前`);
before("app/core/namespace.js", "app/core/utils.js");
before("app/core/utils.js", "app/core/rig.js");
before("app/core/rig.js", "app/features/poser.js");
before("app/platform/haminn.js", "app/services/store.js");
before("app/services/providers.js", "app/services/image-engine.js");
before("app/components/ui.js", "app/components/viewport.js");
before("app/features/self-test.js", "app/app.js");
for (const file of fs.readdirSync(path.join(root, "app"), { recursive: true })) {
  const relative = path.posix.join("app", String(file));
  if (!relative.endsWith(".js")) continue;
  assert.ok(scripts.includes(relative), `app 下的脚本没有被入口加载:${relative}`);
}

/* 4. 语法与依赖底线 */
const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|html|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(path.join(root, "app"));
walk(path.join(root, "styles"));
walk(path.join(root, "tests"));
sourceFiles.push(path.join(root, "index.html"));

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  assert.ok(!/\b(?:import|export)\s+(?:\{|default|from|\*)/.test(source), `ES Module 语法:${relative}`);
  if (!relative.startsWith("tests")) {
    assert.ok(!/\?\.|\?\?|&&=|\|\|=/.test(source), `用了旧 WebView 不支持的语法:${relative}`);
    assert.ok(!/https?:\/\/(?:cdn|unpkg|jsdelivr)/i.test(source), `引用了 CDN:${relative}`);
  }
  if (file.endsWith(".js")) childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
childProcess.execFileSync(process.execPath, ["--check", path.join(root, "vendor/three/three.min.js")], { stdio: "pipe" });
childProcess.execFileSync(process.execPath, ["--check", path.join(root, "vendor/three/OrbitControls.js")], { stdio: "pipe" });

/* 4b. 已知的旧 WebView 布局坑:flex 行里不许用 gap */
for (const file of sourceFiles.filter((name) => name.endsWith(".css"))) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  const rulePattern = /\.[A-Za-z0-9_-]+[^{}]*\{[^{}]*\}/g;
  for (const rule of source.match(rulePattern) || []) {
    if (/display:\s*flex/.test(rule)) {
      assert.ok(!/\bgap\s*:/.test(rule), `flex 行里不能用 gap(旧 WebView 不生效):${relative} ${rule.split("{")[0].trim()}`);
    }
  }
}

/* 4c. 按钮上的字一律不许换行(2026-09-30 用户要求:「所有按钮都要避免换行显示」)。
   为什么它值得一条门禁:`.button` 与 `.chip` 都是 flex 行里的 flex 项,默认 flex-shrink 为 1,
   而**中文的最短可断点只有一个字** —— 一排按钮分不匀时「测试连接」会被压成四行,
   按钮跟着长高,整排跟着乱,而不报任何错。这一条删掉之后门禁之外的测试一条都看不见。
   另一半同样要守:标题 + 说明那种**本来就该多行**的块(.choice-row 等)不许被顺手加上
   nowrap —— 那会把说明文字挤成一条跑出屏幕。两边一起断,才能证明这条规则不是"什么都拦"。 */
{
  const cssFiles = sourceFiles.filter((name) => name.endsWith(".css"));
  const rules = [];
  for (const file of cssFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const rule of source.match(/\.[^{}]+\{[^{}]*\}/g) || []) {
      const [head, body] = [rule.slice(0, rule.indexOf("{")), rule.slice(rule.indexOf("{"))];
      rules.push({ head: head.trim(), body, file: path.relative(root, file) });
    }
  }
  /* 单行按钮:任意一条选择器里点到它、且那条规则写了 nowrap 就算数 */
  const SINGLE_LINE = [".button", ".chip", ".pick-tile", ".dock-button", ".tab-button", ".pose-tile", ".app-menu"];
  for (const token of SINGLE_LINE) {
    const hit = rules.filter((item) => new RegExp(token.replace(".", "\\.") + "(?![A-Za-z0-9_-])").test(item.head));
    assert.ok(hit.length, `门禁失效:一条规则都没匹配到 ${token},单行按钮这条检查已经不在管东西了`);
    assert.ok(hit.some((item) => /white-space:\s*nowrap/.test(item.body)),
      `${token} 是单行按钮,必须有一条规则给它 white-space: nowrap(否则中文标签会被逐字折断)`);
  }
  /* 多行块:它自己那条规则不许出现 nowrap(说明文字被折成一行会跑出屏幕) */
  const MULTI_LINE = [".choice-row", ".tool-row", ".model-pick", ".art-open"];
  for (const token of MULTI_LINE) {
    const own = rules.filter((item) => item.head === token);
    assert.ok(own.length, `门禁失效:${token} 自己那条规则找不到了`);
    assert.ok(!own.some((item) => /white-space:\s*nowrap/.test(item.body)),
      `${token} 是"标题 + 说明"的多行块,不该给它 nowrap`);
  }
  /* 「添加作品」底部那颗「取消」要有宽度下限(2026-09-30 用户要求:取消按钮宽度要增大)。
     只贴两个字那么宽的按钮摆在吃满整行的主按钮旁边,看起来像被挤剩的。 */
  const cancel = rules.filter((item) => /\[data-close-modal\]/.test(item.head));
  assert.ok(cancel.some((item) => /min-width:\s*\d/.test(item.body)),
    "弹层底部的取消按钮(「添加作品」那颗)必须有一个 min-width,不能只有两个字那么宽");
}

/* 4d. 所有毛玻璃面都要压一层黑纱(2026-09-30 用户要求:「把所有毛玻璃背景都变暗一些,
   添加黑色背景透明度」)。
   为什么它值得一条门禁:毛玻璃面分散在四个文件里,漏掉一个**不会报任何错** ——
   只会让那一块比旁边亮一档,而那点差别在真机上很容易被当成"光线问题"放过去。
   判据分两层,少一层就有一条绕过路径:
     a) 黑纱本身 —— --glass-veil 必须在**两套主题**里各定义一次,而且确实是
        `rgba(0,0,0,α)`、α 在 0~0.5 之间:改成灰色或 α 为 0 就是"没压暗";
     b) 玻璃材料 —— --glass 必须把这个量压进自己那一层里(不是另开一个变量搁着);
     c) 每个写了 backdrop-filter 的规则,它的 background 必须走到黑纱(自己引
        --glass-veil,或者用含了它的 --glass)。
   最后那条计数断言是防"门禁失效"的:属性名一旦被改写,循环一个都找不到,
   而它照样绿 —— 那种绿比红危险。 */
{
  const tokens = fs.readFileSync(path.join(root, "styles/tokens.css"), "utf8");
  const themes = {};
  for (const match of tokens.matchAll(/:root(\[data-theme="dark"\])?\s*\{([\s\S]*?)\n\}/g)) {
    themes[match[1] ? "深色" : "亮色"] = match[2];
  }
  assert.equal(Object.keys(themes).length, 2, "tokens.css 里应当正好有亮色与深色两套主题变量");

  for (const name of Object.keys(themes)) {
    const body = themes[name];
    const veil = /(?:^|[\s;])--glass-veil\s*:\s*([^;]+);/.exec(body);
    assert.ok(veil, `${name}主题里没有 --glass-veil:毛玻璃的压暗量必须有唯一出处`);
    const rgba = veil[1].trim().match(/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0?\.\d+|0|1)\s*\)$/);
    assert.ok(rgba, `${name}主题的 --glass-veil 必须是半透明**黑**:收到 ${veil[1].trim()}(灰的等于换材料,不是压暗)`);
    const alpha = Number(rgba[1]);
    assert.ok(alpha > 0 && alpha <= 0.5, `${name}主题的 --glass-veil 透明度 ${alpha} 不在 0~0.5:0 等于没压,过半就成了黑底`);

    const glass = /(?:^|[\s;])--glass\s*:\s*([^;]+);/.exec(body);
    assert.ok(glass, `${name}主题里没有 --glass`);
    assert.match(glass[1], /var\(--glass-veil\)/,
      `${name}主题的 --glass 必须把黑纱压进去(只在旁边定义一个 --glass-veil 是没用的,没人会去引它)`);
  }

  const surfaces = [];
  for (const file of sourceFiles.filter((name) => name.endsWith(".css"))) {
    /* 剥注释再解析:注释里随手写的逗号 / 属性名都会被当成规则的一部分,
       于是报错信息里那个"选择器"会变成一整段中文注释,指不到真正的元素上去。 */
    const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of source.match(/\.[^{}]+\{[^{}]*\}/g) || []) {
      if (!/backdrop-filter\s*:/.test(rule)) continue;
      surfaces.push({
        head: rule.slice(0, rule.indexOf("{")).trim(),
        body: rule.slice(rule.indexOf("{")),
        file: path.relative(root, file)
      });
    }
  }
  assert.ok(surfaces.length >= 5,
    `门禁失效:只找到 ${surfaces.length} 个毛玻璃面(顶栏 / 菜单 / 弹层 / 状态行 / 底部按钮 / 全屏看图工具条),这条检查已经不在管东西了`);
  for (const item of surfaces) {
    const background = /background\s*:\s*([^;}]+)/.exec(item.body);
    assert.ok(background, `${item.file} 的 ${item.head} 是毛玻璃面,却没有 background`);
    assert.match(background[1], /var\(--glass-veil\)|var\(--glass\)/,
      `${item.file} 的 ${item.head} 是毛玻璃面,但它的 background 里没有压暗用的黑纱:${background[1].trim()}`);
  }
}

/* 4e. 全屏看图必须"高度充满"(2026-09-30 用户要求:「渲染图全屏查看的时候,高度要默认充满窗口显示」,
   而且「最小也要高度充满」)。
   为什么它值得一条门禁:这四条属性**缺任何一条都不会报错** —— 舞台是 flex 容器,
   少写 `flex: 0 0 auto` 或 `max-height: none`,浏览器就把画布按舞台的宽度/高度缩回去,
   屏幕上只是"图看着小了一点",没人会当成 bug;而 CSS 的排版结果只有真浏览器算得出来,
   tests/ 下那些纯逻辑测试一条都看不见。
   同一个循环顺带确认组件要的那几个 id 真的在入口里(组件找不到容器时是 `if (!panel) return`,
   静默地什么都不画)。 */
{
  const css = fs.readFileSync(path.join(root, "styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.render-preview-stage\s+canvas\s*\{[^{}]*\}/.exec(css);
  assert.ok(rule, "门禁失效:找不到 .render-preview-stage canvas 那条规则(全屏看图的显示面)");
  const body = rule[0].slice(rule[0].indexOf("{"));
  assert.match(body, /(?:^|[\s;])height\s*:\s*100%/,
    "全屏看图的画布必须有 height:100%(用户要求「高度要默认充满窗口显示」)");
  assert.match(body, /flex\s*:\s*0\s+0\s+auto/,
    "画布必须写 flex:0 0 auto —— 舞台是 flex 容器,不写这条浏览器会按舞台宽度把它缩回去");
  assert.match(body, /max-height\s*:\s*none/,
    "画布必须写 max-height:none,否则高度上限会把它压在舞台之下");
  assert.match(body, /max-width\s*:\s*none/,
    "画布必须写 max-width:none(竖图横向溢出正是「整高」的代价,不该被压回来)");

  const entry = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["render-preview-stage", "render-preview-source", "render-preview-surface",
    "render-preview-adjust", "render-preview-adjustments", "render-preview-zoom"]) {
    assert.ok(entry.includes(`id="${id}"`),
      `入口里没有 #${id}:全屏看图找不到它会静默地什么都不做(源码里看不出任何异常)`);
  }
}

/* 4f. 全屏看图那六个调色滑杆必须由参数表生成(2026-09-30 用户要求:「添加调色工具,参照 HamDraw……,
   调色参数也要保存到作品文档」)。
   为什么它值得一条门禁:面板若自己再列一遍键名 / 行程,那么往后改 render-adjust 里任何一项时,
   滑杆会**照样画出来**(键名还对得上)但行程或后缀是另一套 —— 用户滑到底看到的与实际存进作品的
   不一致,而两边都不报错。render-preview.js 要真 DOM 才能加载,纯逻辑测试到不了这里。 */
{
  const preview = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8");
  assert.match(preview, /adjust\.KEYS\.map\(/,
    "调色面板必须遍历 adjust.KEYS 生成滑杆(自己列一遍键名就会与参数表分叉)");
  assert.match(preview, /adjust\.RANGE\[key\]/,
    "行程与后缀要从 adjust.RANGE[key] 取,不许在面板里另写一套 min/max");
  assert.equal(/data-adjust="[A-Za-z]/.test(preview), false,
    '面板里出现了硬写的 data-adjust="键名":上面那两条遍历就形同虚设了');

  const adjust = fs.readFileSync(path.join(root, "app/services/render-adjust.js"), "utf8");
  const keys = /var\s+KEYS\s*=\s*\[([^\]]*)\]/.exec(adjust);
  assert.ok(keys, "门禁失效:render-adjust.js 里找不到 KEYS");
  const names = keys[1].split(",").map((one) => one.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.equal(names.length, 6,
    `调色参数应当是六项(照 HamDraw:亮度 / 对比度 / 饱和度 / 色相 / 梦幻辉光 / 清晰度),收到 ${names.length} 项`);

  const store = fs.readFileSync(path.join(root, "app/services/store.js"), "utf8");
  assert.match(store, /renderAdjust\.stored\(/,
    "作品文档要把调色收口进 store(用户要求「调色参数也要保存到作品文档」)");
}

/* 4g. 译英在界面上**只剩 label 上那一句**:不许再长出按钮或输入框(2026-09-30 用户定稿:
   「如果配置了翻译模型,每次提交的时候 PoseGi 就自动使用这个翻译模型进行翻译……这样就
   可以去掉所有其他界面上的翻译按钮和输入框」)。
   为什么它值得一条门禁:这套 UI 删掉之后**再加回来在画面上毫无痕迹** ——
   多一个按钮、多一个输入框都不报错,可它与"提交时自动翻译"是两条会打架的路径
   (用户手改的英文框 vs 自动翻出来的英文,到底哪一份发出去没人能一眼看出来)。
   两个方向一起守:源码里不许有按钮/输入框,**样式表里也不许留下它们的规则** ——
   规则留着比删掉更坏,下一个人照着它就能把输入框原样复刻回来。 */
{
  const producers = sourceFiles
    .filter((file) => !path.relative(root, file).startsWith("tests"))
    .filter((file) => /\.(?:js|html)$/.test(file))
    .filter((file) => /data-translate-now|data-translate-input|translate-box/.test(
      fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(producers, [],
    `译英的按钮 / 输入框应当一处都不剩了,现在还有:${producers.join(" / ")}`);

  const css = fs.readFileSync(path.join(root, "styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/\.translate-box\b/.test(css), false,
    ".translate-box 的样式该跟着按钮一起删掉 —— 留着它下一个人照着就能把输入框复刻回来");
  assert.equal(/\.translate-button\b/.test(css), false, ".translate-button 的样式该跟着按钮一起删掉");
}

/* 4h. 标题行主菜单:每个按钮都必须有人接。
   2026-09-30 用户要求「标题行主菜单,创建作品下面添加编辑作品,打开编辑当前作品弹窗」——
   从 html 加一个 <button data-menu="editwork"> 到"点下去真的开弹窗"之间还差一条分支,
   而**只加按钮不接分支的话点下去什么都不发生、也不报错**。这个方向只能静态守:
   界面上"没反应"与"卡了一下"长得一模一样。
   只查这一个方向(每个按钮都有分支):反方向会把别的组件里同名的 action 误判成菜单项。 */
{
  const entry = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const buttons = [...entry.matchAll(/data-menu="([A-Za-z0-9_-]+)"/g)].map((match) => match[1]);
  assert.ok(buttons.length >= 8, `主菜单只找到 ${buttons.length} 个入口,这条检查可能已经失效`);
  assert.equal(new Set(buttons).size, buttons.length, `主菜单里有重复的 data-menu:${buttons.join(" / ")}`);

  const handlers = [];
  for (const relative of scripts.filter((name) => name.startsWith("app/"))) {
    const source = fs.readFileSync(path.join(root, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of source.matchAll(/action\s*===\s*"([A-Za-z0-9_-]+)"/g)) handlers.push(match[1]);
  }
  for (const name of buttons) {
    assert.ok(handlers.includes(name),
      `主菜单里的 data-menu="${name}" 没有任何地方接:点下去什么都不发生,而且不报错`);
  }
}

/* 4i. 顶栏那行当前文档标题:有标题就显示、写不下就省略(2026-09-30 用户要求
   「顶部应用标题栏 版本号后面间隔一点,增加显示当前文档标题,超过可用宽度自动省略」)。
   为什么它值得一条门禁:省略号要**四条属性同时成立**才会出现,而缺任何一条都不报错 ——
     · min-width:0        flex 项默认 min-width:auto,不写它文字会**溢出**容器而不是省略;
     · overflow:hidden    不写它,长标题直接盖到右边的菜单按钮上;
     · white-space:nowrap 不写它,中文会逐字折行,标题块长高把整条顶栏顶变形;
     · text-overflow:ellipsis  不写它,超出部分被**无声裁掉**,看着像"标题本来就短"。
   下面 `[hidden]` 那条更隐蔽:作者样式里的 display 会盖过浏览器对 [hidden] 的默认处理,
   少了它,"没有作品"时那块空白仍然占着位置。
   这五条全是排版结果,tests/ 下的纯逻辑测试一条都看不见(见 tests/topbar-title.test.mjs
   只测了文本与 hidden 逻辑那一半)。 */
{
  const css = fs.readFileSync(path.join(root, "styles/base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.topbar-title\s*\{[^{}]*\}/.exec(css);
  assert.ok(rule, "门禁失效:找不到 .topbar-title 那条规则(顶栏的当前文档标题)");
  const body = rule[0].slice(rule[0].indexOf("{"));
  assert.match(body, /(?:^|[\s;])min-width\s*:\s*0/,
    "标题必须写 min-width:0 —— flex 项默认 min-width:auto,不写它文字会溢出而不是省略");
  assert.match(body, /overflow\s*:\s*hidden/, "标题必须 overflow:hidden,否则长标题盖到菜单按钮上");
  assert.match(body, /white-space\s*:\s*nowrap/,
    "标题必须 white-space:nowrap,否则中文逐字折行把顶栏顶高");
  assert.match(body, /text-overflow\s*:\s*ellipsis/,
    "标题必须 text-overflow:ellipsis(用户要求「超过可用宽度自动省略」)");

  const hidden = /\.topbar-title\[hidden\]\s*\{[^{}]*\}/.exec(css);
  assert.ok(hidden, "门禁失效:找不到 .topbar-title[hidden] 那条规则");
  assert.match(hidden[0], /display\s*:\s*none/,
    ".topbar-title[hidden] 必须显式 display:none(作者样式会盖过浏览器对 [hidden] 的默认处理)");

  const entry = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(entry.includes('id="app-title"'),
    "入口里没有 #app-title:顶栏标题没有落点,而源码里看不出任何异常");
  assert.match(entry, /id="app-version"[\s\S]{0,400}?id="app-title"/,
    "标题要排在版本号**后面**(用户要求「版本号后面间隔一点」)");

  const editor = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
  assert.match(editor, /node\("app-title"\)/, "editor 要从入口里取 #app-title");
  assert.match(editor, /app\.events\.on\("work:changed",\s*syncWorkTitle\)/,
    "标题要订阅 work:changed —— 换作品 / 新建 / 改名 / 删除当前作品四条路径都只发这一个事件;"
    + "少这条订阅,标题会停在启动时那件作品上,而界面上看不出错");
}

/* 4j. 提示词发哪一份、以及"什么时候翻"(2026-09-30 用户定稿):
   「对于设置中文界面的情况:如果模型需要翻译为英文,那么,如果配置了翻译模型,每次提交的
    时候 PoseGi 就自动使用这个翻译模型进行翻译,然后缓存备用避免下次同样内容重复调用模型
    翻译,把翻译结果直接发给生图模型使用;如果没有配置翻译模型,就在提示词输入框添加
    （请使用英文,或软件设置中增加翻译模型）。」「实际上 CHP 内部可以对模型的工作流添加
    翻译节点,就是说 CHP 提供的模型都可以视为不需要中文翻译英文。」
   为什么它值得一条门禁:这几条全是**界面上看不出来的减法**——
     · `prepare` 里少掉那次自动翻译,画面上完全一样(只是每次都把中文原样发给要英文的卡,
       模型那边画不出东西,而界面上一个字都没提);
     · 缓存那一步少掉,只是"同一句话每提交一次就多一个来回",谁也不会当场发现;
     · `needed` 里少掉 CHP 那一条,插件自己会译,于是每次提交都要多等一个来回;
     · 翻译块 / 输入框改回按界面语言出现,卡不需要英文时它又冒出来,用户无从判断对错;
     · 两个表单的 label 少接一个提示,用户写中文发出去、模型画不出东西,界面上也不提。
   tests/ 里那几条只测得到各自那一个函数,拦不住"别处又长出一条路径"。 */
{
  const engine = fs.readFileSync(path.join(root, "app/services/image-engine.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(engine, /services\.translate\.translate\s*\(/,
    "提交时要**自动翻一次** —— 用户要的是「每次提交的时候 PoseGi 就自动使用这个翻译模型"
    + "进行翻译,把翻译结果直接发给生图模型使用」;少了这一步,中文会原样发给要英文的卡");
  assert.match(engine, /services\.translate\.fromPair\(/,
    "翻之前先取现成的 —— 作品里存的那对译文 / 进程内的译英缓存,这正是「缓存备用避免下次"
    + "同样内容重复调用模型翻译」;少了它每张图都要多一次往返");
  assert.match(engine, /services\.translate\.needed\(model\)/,
    "取英文版本之前要问过 needed(卡不要英文时一个字段都不该看,更不该发请求)");
  assert.match(engine, /app\.state\.promptEn\s*=\s*app\.services\.translate\.pair\(/,
    "翻出来的那一份要存进作品(promptEn)—— 否则「缓存备用」只在进程内活着,重启就重翻");

  const translate = fs.readFileSync(path.join(root, "app/services/translate.js"), "utf8");
  assert.match(translate, /function relevant\(\)/, "translate 要导出 relevant():界面中文 + 激活卡要英文");
  assert.match(translate, /app\.services\.providers\s*&&\s*providers\.active|providers\.active\b/,
    "relevant() 要问**当前激活的**那张卡,不能另立一个判据");
  const needed = /function needed\(model\)\s*\{[\s\S]*?\n  \}/.exec(translate);
  assert.ok(needed, "门禁失效:找不到 needed(model)");
  assert.match(needed[0], /"chp"/,
    "needed() 要把 CHP 卡排除掉 —— 用户定:「CHP 内部可以对模型的工作流添加翻译节点,"
    + "就是说 CHP 提供的模型都可以视为不需要中文翻译英文」");

  const hint = fs.readFileSync(path.join(root, "app/components/translate-hint.js"), "utf8");
  assert.match(hint, /function labelHint\(\)/, "要有一个 labelHint():译英服务没配好时写在输入框 label 上");
  assert.match(hint, /if\s*\(!app\.services\.translate\.relevant\(\)\)\s*return "";[\s\S]{0,200}?ready\(\)[\s\S]{0,80}?return ""/,
    "labelHint 的条件要**两条都有**:机制不在就不提,译英服务配好了也不提(那时是自动翻,再喊没用)");

  for (const [relative, label] of [["app/features/editor.js", "生成弹窗"],
    ["app/components/gallery.js", "编辑作品"]]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /translateHint\.labelHint\(\)/,
      `${label}的角色描述 label 要接上 labelHint()(没有译英服务时,那句「请使用英文」只在 label 上)`);
    assert.equal(/translateBox/.test(source), false,
      `${label}里不该再引用 translateBox —— 译英的按钮与输入框都已经撤掉了`);
  }

  const settings = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
  assert.match(settings, /function wantsTranslate\(\)\s*\{\s*return app\.services\.translate\.relevant\(\);/,
    "设置里那一整块译英配置要跟着 relevant() 走(卡不用英文时它就该消失)");
  /* 反向护栏:自动发现那一支**不许**跟着 relevant()——它干的正是"去改卡上这个标记",
     拿被改的东西当条件,卡一旦标错就再也纠正不回来(点一百次「测试连接」也没用)。 */
  assert.match(settings, /function applyDiscovery\(result\)[\s\S]{0,600}?translate\.wanted\(\)/,
    "applyDiscovery 只能判界面语言:它改的就是卡上那个标记,不能拿它当自己的条件");
}

/* 4k. 成图缩略图右上角的删除钮(2026-09-30 用户要求:「渲染,历史成图,每个图片右上角提供
   一个删除按钮,删掉这个图片,不占用 12 个槽位」)。
   为什么它值得一条门禁:这里有两件**不报错但一定坏**的事 ——
     · 删除钮如果是缩略图的**子节点**,那是 button 里嵌 button(非法嵌套):点击会被外层吞掉
       (点删除变成全屏看图),而 HTML 解析器一声不吭;
     · 点下去没有接线(没接 removeResult)时,按钮长得完全正常、按下也有反馈,什么都不发生。
   另外"不占 12 个槽位"这句是**它必须走 store.removeResult**(真的从作品里摘掉、顺手清理媒体),
   而不是在界面上把这一格藏起来 —— 藏起来的那种槽位满了照样生成不了。 */
{
  const editor = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
  assert.match(editor, /data-delete-result="/,
    "缩略图上要有删除钮(用户要求「每个图片右上角提供一个删除按钮」)");
  const nested = /data-result="[^"]*"[^>]*>[\s\S]{0,200}?data-delete-result/.exec(editor);
  assert.equal(nested, null,
    "删除钮不能放在缩略图那个 button **里面**:button 嵌 button 是非法嵌套,点击会被外层吞掉");
  assert.match(editor, /<button class="result-delete"[^>]*data-delete-result/,
    "删除钮要是缩略图的兄弟节点(外面套一层 .result-cell)");
  assert.match(editor, /querySelectorAll\("\[data-delete-result\]"\)[\s\S]{0,200}?removeResult\(/,
    "删除钮必须接到 removeResult 上 —— 不接线的话点下去什么都不发生,而且不报错");
  assert.match(editor, /store\.removeResult\(id\)/,
    "删成图要走 store.removeResult(真的从作品里摘掉),不是界面上藏起来 —— 否则槽位还是占着");
  assert.match(editor, /async function removeResult\([\s\S]{0,400}?confirm\(/,
    "删之前先问一句:成图是本地唯一的一份,删掉找不回来");

  const css = fs.readFileSync(path.join(root, "styles/viewport.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const cell = /\.result-cell\s*\{[^{}]*\}/.exec(css);
  assert.ok(cell, "门禁失效:找不到 .result-cell 那条规则(成图那一格的定位上下文)");
  assert.match(cell[0], /position\s*:\s*relative/,
    ".result-cell 必须 position:relative —— 删除钮靠它定位在右上角");
  const remove = /\.result-delete\s*\{[^{}]*\}/.exec(css);
  assert.ok(remove, "门禁失效:找不到 .result-delete 那条规则");
  assert.match(remove[0], /position\s*:\s*absolute/,
    ".result-delete 必须绝对定位(否则它会挤在缩略图下面,整格变高)");
  assert.match(remove[0], /right\s*:\s*3px[\s\S]*?top\s*:\s*3px/,
    "删除钮要钉在**右上角**(用户要求「每个图片右上角」)");
}

/* 4l. 点选不留外框 + 全屏看图顶部不再写「双击复位」(2026-09-30 用户两条要求:
   「工具弹窗自身和内部元素,点选的时候不要有外部的外框显示」「全屏查看渲染图按钮,
   顶部不要显示提示文字双击复位,底部四个工具按钮点击不要出现额外的外框」)。
   为什么它值得一条门禁:这两件事都**只在一瞬间看得见** —— 松手之后框就没了,
   而它们各自都有两条相反的写法在旁边(要留按压反馈、要留放大时的百分比读数),
   下一次有人"顺手清一下 CSS"就会把其中一半删掉或把文案加回来,谁也不会当场发现。
   `:focus-visible` 特意不写:旧内核不认这个伪类会**整条规则丢掉**(不是不生效,是丢)。 */
{
  const css = fs.readFileSync(path.join(root, "styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.modal-layer\s*:focus\s*,\s*\.render-preview\s*:focus\s*\{[^{}]*\}/.exec(css);
  assert.ok(rule, "门禁失效:找不到关闭焦点外框的那条规则(.modal-layer :focus, .render-preview :focus)");
  assert.match(rule[0], /outline\s*:\s*none/,
    "弹窗与全屏看图的焦点外框要关掉(用户要求「点选的时候不要有外部的外框显示」)");
  assert.equal(/:focus-visible/.test(rule[0]), false,
    "这条规则里不许用 :focus-visible —— 旧 WebView 不认这个伪类,整条规则会被丢掉");
  assert.equal(/-webkit-tap-highlight-color/.test(rule[0]), false,
    "焦点外框与按压高亮是两件事:这里只关 outline,动了 tap-highlight 就等于把按压反馈也关了");

  /* 注释要先抹掉:这段注释本身就写着用户那句原话(「顶部不要显示提示文字双击复位」),
     不抹的话门禁会被自己的说明绊住。 */
  const preview = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/双击复位|Double-tap to reset/.test(preview), false,
    "顶部那行不许再写「双击复位」(用户要求去掉);双击手势本身没变");
  assert.match(preview, /scale === 1 \? ""/,
    "100% 时顶部那行要是空的 —— 元素留着(放大了要报百分比),但不说话");

  const entry = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["render-preview-adjust", "render-preview-reset", "render-preview-delete",
    "render-preview-close"]) {
    assert.ok(entry.includes(`id="${id}"`),
      `底部工具条少了 #${id}:全屏看图里四颗按钮少一颗不报错,只是那件事做不了`);
  }
}

/* 4m. 忙碌时**呼吸的是那颗图标,不是按钮**(2026-09-30 用户要求:「渲染的时候,主界面的
   渲染按钮,不是渲染按钮呼吸闪烁发光,而是渲染 icon 呼吸发光」)。
   为什么它值得一条门禁:这两条都只是"哪儿在动",所以**把动画从按钮挪到图标上在源码里
   看不出错**,画面也照样在动 —— 只是动的还是那颗按钮。而且这里还有一条相反的旧要求
   (「生成时候外面的生成按钮是黑色的」),写的时候很容易把黑底一起删掉。 */
{
  const css = fs.readFileSync(path.join(root, "styles/viewport.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const button = /\.dock-button\.is-busy\s*\{[^{}]*\}/.exec(css);
  assert.ok(button, "门禁失效:找不到 .dock-button.is-busy 那条规则");
  assert.match(button[0], /background\s*:\s*#0b0c0e/,
    "忙碌时那颗按钮仍然是黑的(上一轮的明确要求:「生成时候外面的生成按钮是黑色的」)");
  assert.equal(/animation\s*:/.test(button[0]), false,
    "呼吸不许挂在按钮上(用户要求「不是渲染按钮呼吸闪烁发光」)—— 按钮只留一块静态的黑底");

  const icon = /\.dock-button\.is-busy\s+i\s*\{[^{}]*\}/.exec(css);
  assert.ok(icon, "门禁失效:找不到 .dock-button.is-busy i 那条规则(该呼吸的是图标)");
  assert.match(icon[0], /animation\s*:\s*dock-icon-breathe/,
    "呼吸要挂在图标上(用户要求「而是渲染 icon 呼吸发光」)");
  const frames = /@keyframes\s+dock-icon-breathe\s*\{[\s\S]*?\n\}/.exec(css);
  assert.ok(frames, "门禁失效:找不到 dock-icon-breathe 关键帧");
  /* 数**两处** text-shadow:一亮(发光)一暗(不发光)。只要求"有 text-shadow"是不够的 ——
     暗的那一头本来就写着 `text-shadow: 0 0 0 rgba(...,0)`,把亮的那一头删掉它照样绿,
     而那正好是"呼吸看得出来"的那一半。 */
  assert.ok((frames[0].match(/text-shadow/g) || []).length >= 2,
    "图标的呼吸要一亮一暗两头都写 text-shadow —— 只改 color 的话在黑底上看不出「发光」");
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]{0,400}?\n\}/.exec(css);
  assert.ok(reduced, "门禁失效:找不到「减少动态效果」那一段");
  assert.match(reduced[0], /\.dock-button\.is-busy\s+i/,
    "降级也要落在图标上(否则省动效的人看到的还是那颗按钮在亮)");
}

/* 4n. 选取弹窗:点选对象后关节列表收成一个小三角(2026-09-30 用户要求:「选取工具弹窗,
   改为点选对象后下面的列表折叠为一个小三角(整个弹窗高度变小,只留下顶部按钮和滑竿)」)。
   为什么它值得一条门禁:`.pick-grid` 是 `display:grid`,**作者样式会盖过浏览器对 [hidden]
   的默认处理** —— 少了 `.pick-grid[hidden]{display:none}` 那一行,收起的列表照样铺满一屏,
   而收与不收在源码里长得一模一样(JS 那边 `hidden` 属性明明写上了)。同一个坑这条仓里
   踩过三次(.gen-progress / .button / .modal-layer),所以它必须有一条自己的检查。 */
{
  const css = fs.readFileSync(path.join(root, "styles/viewport.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/\.pick-fold\s*\{[^{}]*\}/.test(css), "门禁失效:找不到 .pick-fold(折叠那一条)");
  const toggle = /\.pick-toggle\s*\{[^{}]*\}/.exec(css);
  assert.ok(toggle, "门禁失效:找不到 .pick-toggle(那颗可点的小三角)");
  assert.match(toggle[0], /width\s*:\s*100%/,
    "三角那一条要整条都能点 —— 收起来之后它是这个面板上唯一的手势入口");
  const hidden = /\.pick-grid\[hidden\]\s*\{[^{}]*\}/.exec(css);
  assert.ok(hidden, "门禁失效:缺少 .pick-grid[hidden] 那条规则 —— display:grid 会盖过 [hidden]");
  assert.match(hidden[0], /display\s*:\s*none/,
    ".pick-grid[hidden] 必须显式 display:none,否则收起之后列表照样铺满一屏");

  const editor = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
  assert.match(editor, /function pickListFolded\(joint\)/,
    "折叠状态要有一个唯一持有者(散在两处迟早对不上)");
  assert.match(editor, /data-pick-toggle/,
    "三角要有个可寻址的标记,否则点它什么都不发生");
  assert.match(editor, /pickListFolded\(!pickListFolded\(\)\)/,
    "点三角要真的翻一次状态");
  assert.match(editor, /aria-expanded="' \+ \(folded \? "false" : "true"\)/,
    "三角要报 aria-expanded —— 收起/展开不只是视觉,读屏那边也要跟着变");
  assert.match(editor, /function renderJointPanel\([\s\S]*?" hidden"/,
    "收起时格子要带 hidden 属性(只靠 CSS 类名切换的话,点一次之后它就再也回不来了)");
  assert.match(editor, /"pose:selected"[\s\S]{0,400}?pickListFolded\(detail\.joint\)/,
    "点选一个关节之后要收起列表 —— 用户要的是「点选对象后下面的列表折叠为一个小三角」");
}

/* 4o. 工具弹窗里不再有「搬运」(2026-09-30 用户要求:「工具弹窗,工具-搬运工具,去掉。」)。
   为什么它值得一条门禁:搬运是一个**模式**(viewport 的 setMode("move")),删掉界面入口
   之后能力还留在原地 —— 于是最可能发生的坏改动是"顺手补回一个入口",或者反过来,
   帮助文案里仍然写着三件事(用户照着找,找不到)。两处都只是文字,不报错。 */
{
  const editor = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
  const sheet = /function openToolsSheet\(\)[\s\S]*?\n  \}/.exec(editor.replace(/\/\*[\s\S]*?\*\//g, ""));
  assert.ok(sheet, "门禁失效:找不到 openToolsSheet()");
  assert.equal(/data-action="move"/.test(sheet[0]), false,
    "工具弹窗里不该再有「搬运」那一项(用户要求去掉)");
  assert.equal(/===\s*"move"/.test(sheet[0]), false,
    "工具弹窗的动作分支里不该再判 move —— 分支留着就等于那一项随时能长回来");

  const settings = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
  assert.equal(/搬运/.test(settings), false,
    "帮助里不该再写「搬运」—— 界面里已经找不到那一项了,用户照着找会以为是坏的");
  assert.match(settings, /「工具」里两件事/,
    "帮助要把「工具」说成两件事(左右镜像 / 相机归位)");
}

/* 4o. 界面上的场景清单与它们的名字、说明一律来自插件(2026-09-30 用户要求:
   「界面下拉菜单数据应该都是来自CHP的数据,不能写死在前端」)。
   `chp/2` 的 `rules[]` 就是这份清单,规范把它列为可选键 —— 客户端按需读、读不到才用
   自己那份(chp-v2-plan §1.2),所以取用点必须只有 providers 一处。
   为什么值得一条门禁:界面上遍历出厂表**看起来完全正常**(那三个场景现在与插件播报的
   逐字相同),只是插件改了说法或多加一个场景时,这里一个都不会跟着动 ——
   而它错起来是"界面在替插件说谎",不会报任何错。 */
{
  const settings = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
  assert.equal(/Object\.keys\(app\.defaults\.chpTasks\)/.test(settings), false,
    "场景清单不许在界面里写死 —— 它来自插件的 rules[](见 providers 的 chpCategories)");
  assert.match(settings, /internals\.chpCategories\(\)/, "任务按钮的清单要取 providers 那一份");
  assert.match(settings, /internals\.taskDescription\(/, "任务下面那句说明也要取 providers 那一份");
}

/* 4p. 调色滑竿的机制:清晰度那一遍**只跟清晰度有关**(2026-09-30 用户要求:
   「全屏查看渲染图界面的调色滑竿现在很卡,请想办法优化算法或机制」)。
   为什么它值得一条门禁:这是纯性能的改动,**画面怎么看都对** ——
   缓存键里多一个 brightness、或者每帧都退回"先颜色再逐像素锐化"那套老写法,
   屏幕上分毫不差,只是每一帧又变回手机上几十上百毫秒的重算。
   tests/render-adjust.test.mjs 从行为上钉住了"拖颜色时逐像素那一遍跑了几次",
   这里再钉住那条不变式本身(键里只许有清晰度),让下一个改它的人一眼看见边界。 */
{
  const adjust = fs.readFileSync(path.join(root, "app/services/render-adjust.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const key = /function clarityKey\(image, settings\)\s*\{[\s\S]*?\n  \}/.exec(adjust);
  assert.ok(key, "门禁失效:找不到 clarityKey(image, settings) —— 清晰度那一张的缓存键");
  for (const tone of ["brightness", "contrast", "saturation", "hue", "glow"]) {
    assert.equal(key[0].includes(tone), false,
      `缓存键里出现了 ${tone}:颜色四项与辉光压在锐化之后画,改它们不该让缓存失效 ——`
      + "把它们写进键里画面照样正确,只是拖滑杆时每一帧都要重算一遍整幅像素");
  }
  assert.match(adjust, /var DRAFT_SCALE\s*=\s*0\.\d+/,
    "拖动期间要先出低分辨率草稿(清晰度那一帧降分辨率,手指停住后补一帧完整的)");
  assert.match(adjust, /options && options\.draft/,
    "draw() 要接第 4 个参数(草稿那一帧),否则拖动期间仍然每帧全分辨率");
  assert.match(adjust, /if \(draft\) sharpenCanvas\(/,
    "草稿帧要在**小画布上**就地锐化掉(它不进缓存,所以不能走缓存那条路)");

  const preview = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(preview, /adjust\.draw\(surface, source, adjustments, \{ draft: drafting \}\)/,
    "显示面要把「这一帧是不是草稿」传给 render-adjust");
  assert.match(preview, /function beginDraft\(\)[\s\S]{0,300}?setTimeout\(endDraft/,
    "要有收尾定时器:手指停住之后补一帧完整分辨率的,否则屏幕上永远停在那张糊的");
  assert.match(preview, /if \(draft\) beginDraft\(\)/,
    "只有滑杆连续事件才走草稿 —— 重置 / 开关这种一次性动作没必要先糊一下再变清楚");
  assert.match(preview, /input\.addEventListener\("input"[\s\S]{0,400}?pushAdjustments\(true\)/,
    "六个滑杆的 input 要传 draft —— 不传的话连续拖动每次都按全分辨率算,那正是「很卡」");
  assert.match(preview, /close\(\)[\s\S]*?clearTimeout\(settleTimer\)/,
    "关掉全屏看图要把收尾那一帧一起取消:关掉之后再去算一次全分辨率的逐像素,白花一次");
}

/* 5. 跨模块契约:调用了但没导出 */
/* 解析对象字面量之前,先把注释"抹成等长空格"。
   为什么必须这么干:契约检查是按字符切对象的,它把**顶层逗号**当字段分隔符,
   而注释里随手写的一个逗号会被当成字段分割 —— 于是那条注释之后紧跟的导出名
   整段被吃掉,检查会报"未导出",可实际上人家明明导出了(viewport 的 setFrontBackMask
   就这样被误判过一次)。抹成同长度空格而不是删掉,是为了让 match.index 与原文一一对应。 */
function blankComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, " "));
}
function objectKeys(source, start) {
  let depth = 0, end = start;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  const body = source.slice(start + 1, end);
  const keys = new Set();
  let depthInner = 0, current = "";
  for (const character of body) {
    if ("{[(".includes(character)) depthInner += 1;
    if ("}])".includes(character)) depthInner -= 1;
    if (character === "," && depthInner === 0) { addKey(keys, current); current = ""; continue; }
    current += character;
  }
  addKey(keys, current);
  return keys;
}
function addKey(keys, chunk) {
  const match = String(chunk).trim().match(/^(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/);
  if (match) keys.add(match[1]);
}

const appFiles = [];
(function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith(".js")) appFiles.push(full);
  }
})(path.join(root, "app"));

const exported = new Map();
for (const file of appFiles) {
  const source = blankComments(fs.readFileSync(file, "utf8"));
  const locals = new Map();
  for (const match of source.matchAll(/(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{/g)) {
    locals.set(match[1], objectKeys(source, match.index + match[0].length - 1));
  }
  for (const match of source.matchAll(/app\.([A-Za-z0-9_.]+)\s*=\s*(\{|([A-Za-z_$][A-Za-z0-9_$]*))/g)) {
    const namespace = "app." + match[1];
    if (match[2] === "{") exported.set(namespace, objectKeys(source, match.index + match[0].length - 1));
    else if (locals.has(match[3])) exported.set(namespace, locals.get(match[3]));
  }
}
assert.ok(exported.size >= 12, `解析到的导出对象太少(${exported.size}),契约检查可能已经失效`);

const problems = [];
for (const file of appFiles) {
  const source = blankComments(fs.readFileSync(file, "utf8"));
  for (const match of source.matchAll(/app\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.([A-Za-z0-9_$]+)\s*\(/g)) {
    const namespace = "app." + match[1];
    if (!exported.has(namespace)) continue;
    if (!exported.get(namespace).has(match[2])) {
      problems.push(`${path.relative(root, file)} 调用了未导出的 ${namespace}.${match[2]}`);
    }
  }
}
assert.equal(problems.join("; "), "", "跨模块导出契约不成立");

/* 6. 纯逻辑测试 */
for (const name of fs.readdirSync(path.join(root, "tests")).filter((entry) => entry.endsWith(".test.mjs")).sort()) {
  childProcess.execFileSync(process.execPath, [path.join(root, "tests", name)], { stdio: "inherit" });
}

if (!sourceOnly && fs.existsSync(path.join(root, "haminn-install.json"))) {
  childProcess.execFileSync("python3", [path.join(root, "tools/package.py"), "--check"], { stdio: "inherit" });
}

console.log(`verify.mjs: ok(检查 ${sourceFiles.length} 个源文件,${exported.size} 个导出对象)`);
