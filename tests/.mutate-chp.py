#!/usr/bin/env python3
"""变异证伪:每条变异都该让某份测试变红。把 providers.js 改回原样后重跑。

用法: python3 tests/.mutate-chp.py
"""
import re, shutil, signal, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROVIDERS = ROOT / "app/services/providers.js"
STORE = ROOT / "app/services/store.js"
BACKUP = pathlib.Path("/tmp/posegi-mutate-backup")

# (名字, 目标文件, 原串, 换成)
MUTATIONS = [
    # 早先这条写的是 `task === "fast" ? "quick" : task` —— 测试全都用 render 卡,
    # 于是它是个空操作(命中 1 次却什么都没改到),后来发现时已绿了一轮。改成就 render 也发错。
    ("场景名不再是卡上那一栏(退回旧词换算)", PROVIDERS,
     "category: task,", 'category: task === "render" ? "quick" : task,'),
    ("画幅退回数组形式", PROVIDERS,
     "      resolution: chosen,", "      size: [chosen, chosen],"),
    ("负向提示词搬回顶层", PROVIDERS,
     "if (input.negativePrompt) ext.negative_prompt = input.negativePrompt;",
     "// 变异"),
    ("负向提示词顶层重发", PROVIDERS,
     "ext_params: ext\n    };", "ext_params: ext, negative_prompt: input.negativePrompt\n    };"),
    ("带 body 的请求也带 Authorization", PROVIDERS,
     "function chpHeaders(config, contentType) {\n    var output = u.parseHeaders(config.customHeaders || \"\");\n    if (contentType) output[\"Content-Type\"] = contentType;\n    return output;",
     "function chpHeaders(config, contentType) {\n    return headers(config, contentType);"),
    ("地址不再读 endpoints", PROVIDERS,
     'var published = chpDocument && chpDocument.endpoints ? chpDocument.endpoints[name] : "";',
     'var published = "";'),
    ("去掉协议大版本闸门", PROVIDERS,
     'if (String(doc.spec) !== CHP_SPEC) {', 'if (false) {'),
    ("密码改走 Authorization 而不是 chp_params", PROVIDERS,
     "if (config.apiKey) body.chp_params = { password: config.apiKey };",
     "if (config.apiKey) body.password = config.apiKey;"),
    ("表里多档时取最后一档(而不是第一条)", PROVIDERS,
     "return list.indexOf(stored) >= 0 ? stored : list[0];",
     "return list.indexOf(stored) >= 0 ? stored : list[list.length - 1];"),
    ("参考图基准固定用出厂表", PROVIDERS,
     "return isFinite(value) && value > 0 ? value : chpSpec(task).refBase;",
     "return chpSpec(task).refBase;"),
    ("ignored 回执不再上报", PROVIDERS,
     "if (ignored.length) {", "if (false) {"),
    ("旧场景名不再迁移", STORE,
     "var LEGACY_TASK = { quick: \"fast\", qwen: \"render\" };",
     "var LEGACY_TASK = {};"),
    # ---- 等待链路的有界重试(2026-09-30 那次「等 80 秒只报内部错误」的修复) ----
    ("只读请求不再重试(上限 1)", PROVIDERS,
     "var POLL_RETRY = 3;", "var POLL_RETRY = 1;"),
    ("重试上限放宽到 6 次(不再是卡上那个数)", PROVIDERS,
     "var POLL_RETRY = 3;", "var POLL_RETRY = 6;"),
    # 锚点要带上下半句:这一句现在在 chpReadQuiet 与 chpSubmit 里各有一处,
    # 只写那一行会命中 2 次(变异无效),而"哪一处"正是这条变异要问的东西。
    ("插件的明确拒绝在只读请求上也照样重试", PROVIDERS,
     "        if (chpTerminal(error)) throw last;\n        if (attempt + 1 < POLL_RETRY) {",
     "        if (false) throw last;\n        if (attempt + 1 < POLL_RETRY) {"),
    ("终态判据不再认 401", PROVIDERS,
     "/unauthorized|401|unsupported_category", "/unauthorized|unsupported_category"),
    ("瞬时错误当成终态(一律不重试)", PROVIDERS,
     "    return /unauthorized|401|unsupported_category|unsupported_size|unsupported_steps|stretched_reference|no_model|invalid_workflow|能力已被拒绝|拒绝了此能力|CAPABILITY_DENIED/.test(text);",
     "    return true;"),
    ("轮询退回裸请求", PROVIDERS,
     "var polled = await chpReadQuiet({ url: progressUrl, method: \"GET\", headers: headers(config), timeoutMs: 15000 });",
     "var polled = await network.request({ url: progressUrl, method: \"GET\", headers: headers(config), timeoutMs: 15000 });"),
    ("取图退回裸请求(已经生成好的图又会被扔掉)", PROVIDERS,
     "var downloaded = await chpReadQuiet({ url: imageUrl, method: \"GET\", headers: headers(config), timeoutMs: 60000 });",
     "var downloaded = await network.request({ url: imageUrl, method: \"GET\", headers: headers(config), timeoutMs: 60000 });"),

    # ---- 「出好的图不会再丢」那条线(2026-09-30:POST 的应答在回程丢了,那张图没人能取) ----
    # 幂等键:没有它,"重发提交"就等于让服务端多画一张,所以提交这一步再也不能重试。
    ("提交不带幂等键", PROVIDERS,
     '    body.request_id = chpNewRequestId();\n', ""),
    ("两次重发各用一个新键(服务端会多排一个作业)", PROVIDERS,
     "    for (var attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {",
     "    for (var attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {\n      body.request_id = chpNewRequestId();"),
    ("提交成功后不把 job id 交上去(那张图从此没人能取)", PROVIDERS,
     '    app.events.emit("generation:pending", { pending: {\n      jobId: jobId, task: task, requestId: body.request_id, createdAt: Date.now()\n    } });\n',
     ""),
    ("取图失败不标 recoverable(界面拿不到那个 job id)", PROVIDERS,
     'throw chpRecoverable(t("图已经画好了,但这次没取回来(网络波动):用「重试取回」再取一次就好,不必重画",',
     'throw new Error(t("图已经画好了,但这次没取回来(网络波动):用「重试取回」再取一次就好,不必重画",'),
    ("取图失败顺手把记录清掉(服务端那张图真丢了)", PROVIDERS,
     '      app.events.emit("generation:progress", { stage: "download",\n        detail: t("图已经画好了,但这次没取回来…", "The image is ready but this fetch failed…") });',
     '      app.events.emit("generation:pending", { pending: null });\n      app.events.emit("generation:progress", { stage: "download",\n        detail: t("图已经画好了,但这次没取回来…", "The image is ready but this fetch failed…") });'),
    ("宿主的裸 timeout 直接甩给用户", PROVIDERS,
     "    if (/^timeout$/i.test(text.trim())) {", "    if (false) {"),
    ("续取也重新提交一次(白重画一张)", PROVIDERS,
     '    if (state !== "completed") return { running: true, job: job };\n    return { running: false, job: job, result: await chpFetchOutput(config, base, job) };',
     '    if (state !== "completed") return { running: true, job: job };\n    await chpSubmit(config, base, chpHeaders(config, "application/json"), {}, "x");\n    return { running: false, job: job, result: await chpFetchOutput(config, base, job) };'),
    # 待取回的作业:改一次标题就把它抹掉,不会报任何错。
    ("待取回的作业不落盘(只在内存里)", STORE,
     "      /* 交出去、还没取回来的那个作业(见 shapePending 上面的注释) */\n      pending: shapePending(app.state.pendingJob)",
     "      pending: null"),
    ("打开作品时不把待取的作业装回来(重启后就取不回来了)", STORE,
     "      app.state.pendingJob = work ? shapePending(work.pending) : null;\n", ""),
    ("改标题顺手把待取的作业抹掉", STORE,
     "    if (whole) {\n      app.state.document = work ? shapeDocument(work) : null;",
     "    app.state.pendingJob = work ? shapePending(work.pending) : null;\n    if (whole) {\n      app.state.document = work ? shapeDocument(work) : null;"),
]


def run(test):
    """跑一份测试。给个上限 —— 变异可能把重试变成死等(退避是递增的),
    真挂住时那条变异要按"被抓住"处理,而不是把整个脚本一起拖死。"""
    try:
        done = subprocess.run(["node", str(ROOT / "tests" / test)],
                              capture_output=True, text=True, cwd=str(ROOT), timeout=90)
    except subprocess.TimeoutExpired:
        return False, ["<测试超时,按被抓住算>"]
    return done.returncode == 0, (done.stdout + done.stderr).strip().splitlines()


if BACKUP.exists():
    shutil.rmtree(BACKUP)
BACKUP.mkdir(parents=True)
shutil.copy2(PROVIDERS, BACKUP / "providers.js")
shutil.copy2(STORE, BACKUP / "store.js")

TESTS = ["chp-jobs.test.mjs", "discovery.test.mjs", "providers.test.mjs",
         "retrieve.test.mjs", "work.test.mjs"]


def restore():
    """把两个源文件放回原样。被 SIGTERM 杀掉时 finally 不会执行 ——
    2026-09-30 真踩过一次:providers.js 被留在 `POLL_RETRY = 99` 上,
    所以这里兜一道,任何退出路径都必须恢复源文件。"""
    if BACKUP.exists():
        for name in ("providers.js", "store.js"):
            if (BACKUP / name).exists():
                shutil.copy2(BACKUP / name, ROOT / "app/services" / name)


def _bye(signum, _frame):
    restore()
    print(f"\n收到信号 {signum},源文件已恢复")
    sys.exit(130)


signal.signal(signal.SIGTERM, _bye)
signal.signal(signal.SIGINT, _bye)

bad = []
try:
    for name, target, old, new in MUTATIONS:
        source = target.read_text()
        if source.count(old) != 1:
            print(f"  ?? {name}: 原串命中 {source.count(old)} 次,变异无效")
            bad.append(name)
            continue
        target.write_text(source.replace(old, new))
        caught = []
        for test in TESTS:
            ok, _ = run(test)
            if not ok:
                caught.append(test)
        shutil.copy2(BACKUP / target.name, target)
        if caught:
            print(f"  红 {name}  ← 被 {', '.join(caught)} 抓住")
        else:
            print(f"  绿 {name}  ← 没有任何测试发现它")
            bad.append(name)
finally:
    restore()

print()
if bad:
    print(f"变异未被发现 {len(bad)}/{len(MUTATIONS)}: {bad}")
    sys.exit(1)
print(f"全部 {len(MUTATIONS)} 条变异都被抓住了")
