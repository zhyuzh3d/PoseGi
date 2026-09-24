/* PoseGi 静态检查与纯逻辑测试
 *
 * 检查项:
 *   1. 清单:hermit.json 的 schema、happId、版本号
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
const manifest = JSON.parse(fs.readFileSync(path.join(root, "hermit.json"), "utf8"));
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
  if (reference.startsWith("/__hermit/") || reference.startsWith("data:")) continue;
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
before("app/platform/hermit.js", "app/services/store.js");
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

/* 5. 跨模块契约:调用了但没导出 */
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
  const source = fs.readFileSync(file, "utf8");
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
  const source = fs.readFileSync(file, "utf8");
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

if (!sourceOnly && fs.existsSync(path.join(root, "hermit-install.json"))) {
  childProcess.execFileSync("python3", [path.join(root, "tools/package.py"), "--check"], { stdio: "inherit" });
}

console.log(`verify.mjs: ok(检查 ${sourceFiles.length} 个源文件,${exported.size} 个导出对象)`);
