#!/usr/bin/env python3
"""变异证伪(2026-09-30 那一轮要求,分批累积)。

每条变异都该让 tools/verify.mjs 变红(它先跑门禁、再跑 tests/ 下的测试)。
把改过的文件还原后重跑,全绿才算数。

为什么必须有这一层:这一批新加的门禁(4k 成图右上角的叉 / 4l 不留焦点外框与顶部不再写
「双击复位」/ 4m 忙碌时呼吸的是图标而不是按钮 / 4n 点选后关节列表收成小三角 /
4o 工具弹窗里不再有搬运 / 4p 清晰度那一遍只跟清晰度有关)与 tests/pick-fold.test.mjs、
tests/result-delete.test.mjs、tests/render-adjust.test.mjs 里那几条行为断言,全都是
"拦不该发生的事"。那种断言**天生可能什么都没拦**——
绿着,而对应的要求早就丢了。只有把要求真的破坏一次、看它变红,才能证明它还在管东西。
4p 那几条尤其典型:缓存键里多一个参数、或者每帧退回"先颜色再逐像素锐化"那套老写法,
画面上分毫不差,只是滑杆又变回手机上几十上百毫秒一帧 —— 没有任何东西会变红。

用法: python3 tests/.mutate-ui.py
"""
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PREVIEW = ROOT / "app/components/render-preview.js"
ADJUST = ROOT / "app/services/render-adjust.js"
HINT = ROOT / "app/components/translate-hint.js"
SETTINGS = ROOT / "app/components/settings.js"
GALLERY = ROOT / "app/components/gallery.js"
ENGINE = ROOT / "app/services/image-engine.js"
TRANSLATE = ROOT / "app/services/translate.js"
STORE = ROOT / "app/services/store.js"
EDITOR = ROOT / "app/features/editor.js"
CSS = ROOT / "styles/components.css"
BASE = ROOT / "styles/base.css"
VP = ROOT / "styles/viewport.css"
ENTRY = ROOT / "index.html"
BACKUP = pathlib.Path("/tmp/posegi-mutate-ui-backup")

# (名字, [(目标文件, 原串, 换成)])
MUTATIONS = [
    # --- 全屏看图:高度充满 + 最小也要高度充满 ---
    ("缩放下限退成 0.5(比整高还小)", [(PREVIEW,
     "return Math.max(1, Math.min(8, grown));",
     "return Math.max(0.5, Math.min(8, grown));")]),
    ("平移余量允许负数(图能被推出屏幕外)", [(PREVIEW,
     "return Math.max(0, (size * currentScale - stageSize) / 2);",
     "return (size * currentScale - stageSize) / 2;")]),
    ("画布去掉 max-height:none(高度被压回舞台之内)", [(CSS,
     "  flex: 0 0 auto; max-width: none; max-height: none;",
     "  flex: 0 0 auto; max-width: none;")]),
    ("画布去掉 flex:0 0 auto(被 flex 舞台缩回去)", [(CSS,
     "  display: block; width: auto; height: 100%;\n  flex: 0 0 auto; max-width: none; max-height: none;",
     "  display: block; width: auto; height: 100%;\n  max-width: none; max-height: none;")]),
    ("入口里删掉调色面板容器", [(ENTRY,
     'id="render-preview-adjustments"', 'id="render-preview-adjustments-x"')]),

    # --- 调色 ---
    ("面板把键名硬写进 data-adjust", [(PREVIEW,
     '\'<input type="range" min="\' + range.min + \'" max="\' + range.max',
     '\'<input type="range" data-adjust="brightness" min="\' + range.min + \'" max="\' + range.max')]),
    ("参数表掉一项(滑杆与文档少一项)", [(ADJUST,
     'var KEYS = ["brightness", "contrast", "saturation", "hue", "glow", "clarity"];',
     'var KEYS = ["brightness", "contrast", "saturation", "hue", "glow"];')]),
    ("没有辉光时也提亮 8%(退回旧写法)", [(ADJUST,
     "if (glow <= 0) return colorFilter(settings);",
     "if (false) return colorFilter(settings);")]),
    ("作品文档不再收口调色", [(STORE,
     "function shapeRender(raw) { return app.services.renderAdjust.stored(raw); }",
     "function shapeRender(raw) { return null; }")]),

    # --- 译英在界面上只剩 label 那一句(4g):按钮与输入框都不许再长回来 ---
    ("生成弹窗里又长出一个翻译按钮", [(EDITOR,
     '      app.components.translateHint.labelHint() + "</span>" +',
     '      \'<button type="button" data-translate-now></button>\' + '
     'app.components.translateHint.labelHint() + "</span>" +')]),
    ("编辑作品里又摆回一个英文输入框", [(GALLERY,
     "        app.components.translateHint.labelHint() + '</span>' +",
     "        '<textarea data-translate-input></textarea>' + "
     "app.components.translateHint.labelHint() + '</span>' +")]),
    ("样式表里留着 .translate-box 那条规则", [(CSS,
     ".translate-card {", ".translate-box { position: relative; }\n.translate-card {")]),

    # --- 提交时自动译英 + CHP 卡一律不翻(4j) ---
    ("labelHint 不再问机制在不在(卡不要英文时也喊)", [(HINT,
     "    if (!app.services.translate.relevant()) return \"\";\n", "")]),
    ("labelHint 不再问服务配没配好(自动翻了还在催)", [(HINT,
     "    if (app.services.translate.ready()) return \"\";\n", "")]),
    ("英文界面下那句提示只剩中文那半句", [(HINT,
     '    return t("（请使用英文,或软件设置中增加翻译模型）",\n'
     '      " (please use English, or add a translation model in Preferences)");',
     '    return t("（请使用英文,或软件设置中增加翻译模型）", "");')]),
    ("生成弹窗的 label 不再接提示", [(EDITOR,
     '      app.components.translateHint.labelHint() + "</span>" +',
     '      "" + "</span>" +')]),
    ("编辑作品的 label 不再接提示", [(GALLERY,
     "        app.components.translateHint.labelHint() + '</span>' +",
     "        '' + '</span>' +")]),
    ("提交时不再自动翻(中文原样发给要英文的卡)", [(ENGINE,
     "    await app.services.translate.translate([prompt]);\n", "")]),
    ("译英不再先问缓存(每张图都多一次往返)", [(ENGINE,
     "    var ready = app.services.translate.fromPair({ promptEn: app.state.promptEn }, prompt);",
     '    var ready = "";')]),
    ("译文不再存回作品(重启就重翻一遍)", [(ENGINE,
     "    app.state.promptEn = app.services.translate.pair(prompt, english);",
     "    app.state.promptEn = null;")]),
    ("CHP 卡也翻一遍(插件本来就会译,白多一个来回)", [(TRANSLATE,
     '    return String(model.protocol || "chp") !== "chp";',
     "    return true;")]),
    ("设置里那一整块退回只按界面语言出现", [(SETTINGS,
     "  function wantsTranslate() { return app.services.translate.relevant(); }",
     "  function wantsTranslate() { return app.services.translate.wanted(); }")]),

    # --- 主菜单 ---
    ("「编辑作品」按钮没人接(点了没反应)", [(EDITOR,
     '      if (action === "editwork") openEditWorkSheet();\n',
     "")]),

    # --- 顶栏那行当前文档标题(4i) ---
    ("标题不再省略(超出部分被无声裁掉)", [(BASE,
     "  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;",
     "  overflow: hidden; white-space: nowrap;")]),
    ("标题丢掉 min-width:0(文字溢出容器而不是省略)", [(BASE,
     "  flex: 0 1 auto; min-width: 0; margin-left: 8px;",
     "  flex: 0 1 auto; margin-left: 8px;")]),
    ("标题允许断行(中文逐字折行,顶栏被顶高)", [(BASE,
     "  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;",
     "  overflow: hidden; text-overflow: ellipsis;")]),
    ("标题不再裁剪溢出(长标题盖到菜单按钮上)", [(BASE,
     "  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;",
     "  white-space: nowrap; text-overflow: ellipsis;")]),
    ("[hidden] 那条规则改名(没有作品时仍占着位置)", [(BASE,
     ".topbar-title[hidden] { display: none; }",
     ".topbar-title-hidden { display: none; }")]),
    ("标题不再订阅 work:changed(换作品后停在上一件)", [(EDITOR,
     '    app.events.on("work:changed", syncWorkTitle);\n', "")]),
    ("入口里删掉标题那个 span", [(ENTRY,
     'id="app-title"', 'id="app-title-x"')]),
    ("标题挪到版本号前面(用户要求的是后面)", [(ENTRY,
     '          <span class="topbar-title" id="app-title" hidden></span>\n', ""),
     (ENTRY,
      '<small id="app-version"></small>',
      '<span class="topbar-title" id="app-title" hidden></span>\n          <small id="app-version"></small>')]),
    ("没有标题时也照旧显示(hidden 恒 false)", [(EDITOR,
     "    label.hidden = !title;", "    label.hidden = false;")]),
    ("标题不再 trim(几个空格也当标题写出去)", [(EDITOR,
     '    var title = String(app.state.workTitle || "").trim();',
     '    var title = String(app.state.workTitle || "");')]),

    # --- 选取弹窗:点选之后收成一个小三角(4n) ---
    ("点选之后不再收起列表(用户要的是点完就收)", [(EDITOR,
     "      pickListFolded(detail.joint);\n", "")]),
    ("收起时网格不带 hidden(收起来照样铺满一屏)", [(EDITOR,
     "'<div class=\"pick-grid\"' + (folded ? \" hidden\" : \"\") + \">\";",
     "'<div class=\"pick-grid\">';")]),
    ("[hidden] 那条规则丢掉(display:grid 会盖过它)", [(VP,
     ".pick-grid[hidden] { display: none; }",
     ".pick-grid-hidden { display: none; }")]),
    ("三角不再翻状态(点它没反应)", [(EDITOR,
     "      pickListFolded(!pickListFolded());\n", "")]),
    ("三角的 aria-expanded 恒为 false(读屏那边被骗)", [(EDITOR,
     "aria-expanded=\"' + (folded ? \"false\" : \"true\") + '\"",
     "aria-expanded=\"' + (true ? \"false\" : \"true\") + '\"")]),

    # --- 成图右上角那个叉(4k) ---
    ("叉塞进缩略图里面(button 嵌 button,点击被外层吞掉)", [(EDITOR,
     '"</span></button>" +\n        \'<button class="result-delete"',
     '"</span>" +\n        \'<button class="result-delete"')]),
    ("叉挂了样式却没接线(按下去什么都不发生)", [(EDITOR,
     "      button.onclick = app.components.ui.action(function () {\n"
     "        return removeResult(button.dataset.deleteResult);\n      });\n", "")]),
    ("删成图改成界面上不管(槽位还占着)", [(EDITOR,
     "    await app.services.store.removeResult(id);\n",
     "    app.components.ui.toast(id);\n")]),
    ("确认框里点取消也照删", [(EDITOR,
     "    if (!confirmed) return false;\n", "")]),
    ("叉不再钉在右上角(挤在缩略图下面)", [(VP,
     ".result-delete {\n  position: absolute; right: 3px; top: 3px;",
     ".result-delete {\n  position: static; right: 3px; top: 3px;")]),

    # --- 点选不留外框 + 顶部不再写「双击复位」(4l) ---
    ("焦点外框那条规则改用 :focus-visible(旧内核整条丢掉)", [(CSS,
     ".modal-layer :focus,\n.render-preview :focus { outline: none; }",
     ".modal-layer :focus-visible,\n.render-preview :focus-visible { outline: none; }")]),
    ("顶部又写回「双击复位」", [(PREVIEW,
     'zoom.textContent = scale === 1 ? "" :',
     'zoom.textContent = scale === 1 ? t("双击复位", "Double-tap to reset") :')]),
    ("100% 时顶部也要说话(用户要的是不显示)", [(PREVIEW,
     'zoom.textContent = scale === 1 ? "" :',
     'zoom.textContent = scale === 1 ? "100%" :')]),
    ("底部工具条少一颗按钮", [(ENTRY,
     'id="render-preview-delete"', 'id="render-preview-delete-x"')]),

    # --- 忙碌时呼吸的是那颗图标(4m) ---
    ("呼吸又挂回按钮上(用户要的是 icon 发光)", [(VP,
     ".dock-button.is-busy {\n  background: #0b0c0e; color: #fff;\n  border-color: #0b0c0e;\n}\n"
     ".dock-button.is-busy i { animation: dock-icon-breathe 1.9s ease-in-out infinite; }",
     ".dock-button.is-busy {\n  background: #0b0c0e; color: #fff;\n  border-color: #0b0c0e;\n"
     "  animation: dock-icon-breathe 1.9s ease-in-out infinite;\n}\n.dock-button.is-busy i { color: #fff; }")]),
    ("忙碌时不再是黑底(上一轮的要求丢了)", [(VP,
     ".dock-button.is-busy {\n  background: #0b0c0e; color: #fff;\n  border-color: #0b0c0e;\n}",
     ".dock-button.is-busy {\n  color: #fff;\n  border-color: #0b0c0e;\n}")]),
    ("图标呼吸只剩颜色、没有发光", [(VP,
     "  50% { color: #b9b9ff; text-shadow: 0 0 12px rgba(154,154,245,.9), 0 0 22px rgba(154,154,245,.5); }",
     "  50% { color: #b9b9ff; }")]),

    # --- 工具弹窗里不再有「搬运」(4o) ---
    ("工具弹窗又摆回「搬运」那一项", [(EDITOR,
     '\'<div class="tool-group"><span class="section-label">\' + text("造型", "Pose") + "</span>" +',
     '\'<div class="tool-group"><span class="section-label">\' + text("造型", "Pose") + "</span>" +\n'
     '      \'<button class="tool-row" data-action="move"><i class="fa-solid fa-arrows-up-down-left-right" aria-hidden="true"></i>\' +\n'
     "      '<span><strong>搬运</strong></span></button>' +")]),
    ("工具弹窗又判起了 move 分支", [(EDITOR,
     '            if (button.dataset.action === "mirror") {',
     '            if (button.dataset.action === "move") { return; }\n'
     '            if (button.dataset.action === "mirror") {')]),
    ("帮助里又写回三件事(用户照着找找不到)", [(SETTINGS,
     't("「工具」里两件事:左右镜像(左右姿势整体翻转)、相机归位。"',
     't("「工具」里三件事:搬运、左右镜像、相机归位。"')]),

    # --- 调色滑竿:清晰度那一遍只跟清晰度有关(4p) ---
    ("缓存键里加上 brightness(画面照样对,每帧重算)", [(ADJUST,
     'return sourceKey(image) + "|" + settings.clarity + "|"',
     'return sourceKey(image) + "|" + settings.clarity + "|" + settings.brightness + "|"')]),
    ("草稿也把缓存填上(屏幕上再也回不到清晰)", [(ADJUST,
     "var base = amount && !draft ? (clarityBase(image, settings) || image) : image;",
     "var base = amount ? (clarityBase(image, settings) || image) : image;")]),
    ("四邻域读的是写过的输出(锐化沿扫描方向走样)", [(ADJUST,
     "            (input[offset - 4 + channel] + input[offset + 4 + channel] +\n"
     "              input[offset - stride + channel] + input[offset + stride + channel]);",
     "            (output[offset - 4 + channel] + output[offset + 4 + channel] +\n"
     "              output[offset - stride + channel] + output[offset + stride + channel]);")]),
    ("显示面不再传草稿(拖动期间每帧全分辨率)", [(PREVIEW,
     "adjust.draw(surface, source, adjustments, { draft: drafting })",
     "adjust.draw(surface, source, adjustments)")]),
    ("收尾那一帧不补了(屏幕上永远停在糊的那张)", [(PREVIEW,
     "    if (settleTimer) clearTimeout(settleTimer);\n    settleTimer = setTimeout(endDraft, DRAFT_SETTLE_MS);",
     "    if (settleTimer) clearTimeout(settleTimer);")]),
    ("滑杆不再走草稿(连续 input 每帧全分辨率)", [(PREVIEW,
     "        pushAdjustments(true);", "        pushAdjustments();")]),
    ("关掉全屏看图不再取消收尾帧(白算一次全分辨率)", [(PREVIEW,
     "    if (settleTimer) clearTimeout(settleTimer);\n    settleTimer = 0;\n    drafting = false;",
     "    settleTimer = 0;\n    drafting = false;")]),

    # --- 「重试取回」那颗按钮与续取收尾(2026-09-30:出好的图不会再丢) ---
    # 底部那排按钮住在 #modal-actions,而它是 #modal-content 的**兄弟**而不是子节点
    # (见 index.html)。从内容区里查永远是 null 而且**不报错** —— 所以查错根这件事
    # 只有把真结构跑一遍才发现得了:tests/retrieve.test.mjs 的替身就照真结构搭的。
    ("按钮从内容区里查(兄弟结构那个坑)", [(EDITOR,
     '  function sheetRoot() { return node("modal-layer"); }',
     '  function sheetRoot() { return node("modal-content"); }')]),
    ("取回按钮不看有没有东西可取(摆一颗点了没用的)", [(EDITOR,
     "    if (retrieve) retrieve.hidden = busy || !app.services.imageEngine.pending();",
     "    if (retrieve) retrieve.hidden = busy;")]),
    ("续取成功后不清记录(一颗按不完的按钮)", [(ENGINE,
     "      app.state.pendingJob = null;\n      app.services.store.scheduleSave();\n      succeeded = true;",
     "      succeeded = true;")]),
    ("服务端还在跑时就把记录清掉(再也取不回来)", [(ENGINE,
     "      if (found.running) {",
     "      if (found.running) {\n        app.state.pendingJob = null;")]),
    ("取消之后还留着待取的作业(刚说不想要它了)", [(ENGINE,
     "    if (app.state.pendingJob) {\n      app.state.pendingJob = null;\n      app.services.store.scheduleSave();\n    }\n",
     "")]),
]


def run():
    done = subprocess.run(
        ["node", str(ROOT / "tools/verify.mjs"), "--source-only"],
        capture_output=True, text=True, cwd=str(ROOT))
    text = (done.stdout + done.stderr).splitlines()
    return done.returncode == 0, reason(text)


def reason(lines):
    """报"被谁抓住"要报**那句话**,不是报 node 的版本行。
    断言失败长这样:`AssertionError [ERR_ASSERTION]: 全屏看图的画布必须有 height:100%...`"""
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("AssertionError") or stripped.startswith("Error:"):
            head, _, tail = stripped.partition(": ")
            return tail or head
    for line in reversed(lines):
        if line.strip() and not line.startswith("Node.js"):
            return line.strip()
    return "(没有可读的错误信息)"


if BACKUP.exists():
    shutil.rmtree(BACKUP)
BACKUP.mkdir(parents=True)
TARGETS = [PREVIEW, ADJUST, HINT, SETTINGS, GALLERY, ENGINE, TRANSLATE, STORE, EDITOR,
           CSS, BASE, VP, ENTRY]
for target in TARGETS:
    shutil.copy2(target, BACKUP / target.name)

bad = []
try:
    for name, steps in MUTATIONS:
        broken = []
        for target, old, new in steps:
            source = target.read_text()
            if source.count(old) != 1:
                print(f"  ?? {name}: 原串在 {target.name} 里命中 {source.count(old)} 次,变异无效")
                broken.append(target)
                continue
            target.write_text(source.replace(old, new))
            broken.append(target)
        if len(broken) != len(steps):
            bad.append(name)
            for target in dict.fromkeys(broken):
                shutil.copy2(BACKUP / target.name, target)
            continue

        ok, why = run()
        for target in dict.fromkeys(broken):
            shutil.copy2(BACKUP / target.name, target)
        if ok:
            print(f"  绿 {name}  ← 没有任何检查发现它(要求已经丢了,门禁却还是绿的)")
            bad.append(name)
        else:
            print(f"  红 {name}\n      ← {why[:170]}")
finally:
    for target in TARGETS:
        shutil.copy2(BACKUP / target.name, target)

print()
ok, _ = run()
print("还原后门禁:" + ("全绿" if ok else "仍然红!必须自己查"))
if bad or not ok:
    if bad:
        print(f"变异未被发现 {len(bad)}/{len(MUTATIONS)}: {bad}")
    sys.exit(1)
print(f"全部 {len(MUTATIONS)} 条变异都被抓住了")
