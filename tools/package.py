#!/usr/bin/env python3
"""构建或校验 PoseGi 的确定性发布包。

运行包白名单只有这里一处出处(RUNTIME_ROOTS);改这里就等于改整个项目的发布边界。
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import pathlib
import sys
import time
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = ("index.html", "haminn.json", "guid.md", "app", "styles", "vendor")
FIXED_TIMESTAMP = (2026, 9, 24, 0, 0, 0)

# 包自己声明的来源与作者信息。这里的每一个字段都只是打包者的说法：接收方一律以自己算出的内容
# 指纹为准，读这个文件只是为了在询问用户时告诉他这包是谁做的。文件可缺省，缺了照样安装、照样开发。
BUILD_NAME = "haminn-build.json"
BUILD_SCHEMA = 1
UNUSABLE_USER_NAMES = frozenset({"root", "unknown", "none", "nobody", "administrator"})
# 「本包基于哪个包」的链条最多回溯这么多层，超出即截断：包不该携带一段无界的家谱。
BASED_ON_DEPTH = 8
BASED_ON_FIELDS = ("name", "happId", "versionName", "versionCode", "author", "maintainer", "packagedAt")
FINGERPRINT_KEYS = frozenset({"treeHash", "sha256", "hash", "digest", "fingerprint"})

# Editor and operating-system droppings must never reach a shipped archive.
# `.DS_Store` shows up from merely browsing `app/` in Finder, and an unfiltered
# walk would bake it into the release (and into the website copy, which re-uses
# these entry names).
JUNK_NAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini"})
JUNK_DIRS = frozenset({"__pycache__", ".vscode", ".idea"})


def is_runtime_file(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    if path.name in JUNK_NAMES or path.name.startswith("._"):
        return False
    return not JUNK_DIRS.intersection(path.relative_to(ROOT).parts)


def runtime_files() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for relative in RUNTIME_ROOTS:
        target = ROOT / relative
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            files.extend(path for path in target.rglob("*") if is_runtime_file(path))
        else:
            raise SystemExit(f"missing runtime path: {relative}")
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def manifest() -> dict:
    return json.loads((ROOT / "haminn.json").read_text(encoding="utf-8"))


def release_info(declared: dict) -> tuple[str, pathlib.Path]:
    relative = f"release/posegi-v{declared['version']['name']}.zip"
    return relative, ROOT / relative


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- 这次打包是谁做的 ------------------------------------------------------------------------


def usable_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and bool(name.strip())
        and name.strip().lower() not in UNUSABLE_USER_NAMES
    )


def system_user_name() -> str:
    """这台机器签名用的名字；没有就返回空串。"""
    for candidate in (os.environ.get("USER"), os.environ.get("LOGNAME"), os.environ.get("USERNAME")):
        if candidate and candidate.strip():
            return candidate.strip()
    try:
        return (getpass.getuser() or "").strip()
    except Exception:
        return ""


def ask_for_maintainer() -> str:
    """哪儿都拿不到可用的名字：停下问人，不拿猜来的名字给包签名。

    空名字或编出来的名字比没有名字更糟，因为它看起来像是信息。
    """
    if not sys.stdin.isatty():
        raise SystemExit(
            "无法确定更新者姓名：请用 --maintainer 指定，或在 haminn.json 里写 maintainer"
        )
    print("这台机器上拿不到可用的用户名（拿不到登录名，或它只是 root 一类无意义值）。")
    for _ in range(3):
        try:
            answer = input("请写明这次打包的更新者姓名: ")
        except EOFError:
            break
        if usable_name(answer):
            return answer.strip()
        print("这个名字不能用（空、或 root/unknown 一类无意义值），请换一个。")
    raise SystemExit("没有拿到更新者姓名，打包中止")


def resolve_maintainer(declared: dict, override: str | None = None) -> str:
    for candidate in (override, declared.get("maintainer"), system_user_name()):
        if usable_name(candidate):
            return candidate.strip()
    return ask_for_maintainer()


# --- 这个包说自己是基于什么做的 --------------------------------------------------------------


def previous_build_record(output: pathlib.Path) -> dict:
    """同版本号下已经打好的那个包声明了什么。

    复用它才能让「没改版本再打一次」逐字节一致：确定性校验比的就是哈希，而新取的时间戳会破坏它。
    """
    if not output.is_file():
        return {}
    try:
        with zipfile.ZipFile(output) as archive:
            record = json.loads(archive.read(BUILD_NAME).decode("utf-8"))
    except (OSError, KeyError, UnicodeError, json.JSONDecodeError, zipfile.BadZipFile):
        return {}
    return record if isinstance(record, dict) else {}


def trim_chain(record: dict, depth: int) -> dict:
    """只保留声明的字段，最多回溯 depth 代。

    白名单同时就是「包里不放内容指纹」的实现：父包的指纹只能在父包封口之后才算得出来，对接收方也毫无价值。
    """
    kept = {name: record[name] for name in BASED_ON_FIELDS if name in record}
    parent = record.get("basedOn")
    if depth > 1 and isinstance(parent, dict):
        kept["basedOn"] = trim_chain(parent, depth - 1)
    return kept


def load_based_on(source: str | None) -> dict | None:
    """本包基于哪个包开发，取自打包者自己的记录文件。

    显式 --based-on 指向不存在的文件是错误；默认位置不存在只说明这次不是接着别人的包做的。
    """
    if source:
        path = pathlib.Path(source).expanduser()
        if not path.is_file():
            raise SystemExit(f"basedOn 记录文件不存在：{path}")
    else:
        path = ROOT / BUILD_NAME
        if not path.is_file():
            return None
    try:
        parent = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(f"basedOn 记录文件读不出来：{path}")
    if not isinstance(parent, dict):
        raise SystemExit(f"basedOn 记录不是一个对象：{path}")
    return trim_chain(parent, BASED_ON_DEPTH)


def build_record(declared: dict, maintainer: str, based_on: dict | None, output: pathlib.Path) -> dict:
    previous = previous_build_record(output)
    packaged_at = previous.get("packagedAt")
    if not isinstance(packaged_at, str) or not packaged_at:
        packaged_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "schema": BUILD_SCHEMA,
        "happId": declared["happId"],
        "name": declared["name"],
        "versionName": declared["version"]["name"],
        "versionCode": declared["version"]["code"],
        "author": declared.get("author"),
        "maintainer": maintainer,
        "packagedAt": packaged_at,
    }
    if based_on:
        record["basedOn"] = based_on
    return record


def encode_record(record: dict) -> bytes:
    return (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


# --- 包本身 ----------------------------------------------------------------------------------


def build(output: pathlib.Path, extra: dict[str, bytes] | None = None) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in runtime_files():
            relative = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
        for name, payload in sorted((extra or {}).items()):
            info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)
    if output.exists():
        if sha256(temporary) != sha256(output):
            temporary.unlink()
            raise SystemExit("同名发布包已存在且内容不同,请先递增版本号再打包")
        temporary.unlink()
    else:
        temporary.replace(output)
    return sha256(output)


def write_install_manifest(package_path: str, digest: str) -> None:
    content = {"schema": 1, "package": package_path, "sha256": digest}
    (ROOT / "haminn-install.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def declared_fingerprints(value: object) -> list[str]:
    if isinstance(value, dict):
        found = [key for key in value if key in FINGERPRINT_KEYS]
        return found + [name for item in value.values() for name in declared_fingerprints(item)]
    if isinstance(value, list):
        return [name for item in value for name in declared_fingerprints(item)]
    return []


def check_declared(payload: bytes, declared: dict) -> None:
    """包自己的说法至少要说得通、而且说的就是这个包。

    这里不核实任何内容——也没法核实。目的只是让它看起来是一份自述，而不是一份权威结论。
    """
    try:
        record = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise SystemExit(f"{BUILD_NAME} 不是合法 JSON")
    if not isinstance(record, dict) or record.get("schema") != BUILD_SCHEMA:
        raise SystemExit(f"{BUILD_NAME} 不是 schema {BUILD_SCHEMA} 的记录")
    if record.get("happId") != declared["happId"] or record.get("versionName") != declared["version"]["name"]:
        raise SystemExit(f"{BUILD_NAME} 描述的不是这个包")
    if not usable_name(record.get("maintainer")):
        raise SystemExit(f"{BUILD_NAME} 没有可用的更新者姓名")
    fingerprints = declared_fingerprints(record)
    if fingerprints:
        raise SystemExit(f"{BUILD_NAME} 不得声明内容指纹：{sorted(set(fingerprints))}")


def verify(package_path: str, output: pathlib.Path, declared: dict) -> None:
    if not output.is_file():
        raise SystemExit(f"release archive missing: {output}")
    install = json.loads((ROOT / "haminn-install.json").read_text(encoding="utf-8"))
    digest = sha256(output)
    if install != {"schema": 1, "package": package_path, "sha256": digest}:
        raise SystemExit("haminn-install.json does not match the release archive")
    expected = {path.relative_to(ROOT).as_posix() for path in runtime_files()}
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        # 声明文件是可选的：它出现之前打好的包依然有效，安装方遇到缺失也只是少显示一栏。
        if len(names) != len(set(names)) or set(names) - {BUILD_NAME} != expected:
            raise SystemExit("release archive does not match the runtime allowlist")
        for path in runtime_files():
            relative = path.relative_to(ROOT).as_posix()
            if archive.read(relative) != path.read_bytes():
                raise SystemExit(f"release content mismatch: {relative}")
        if BUILD_NAME in names:
            check_declared(archive.read(BUILD_NAME), declared)
    print(f"verified {output.relative_to(ROOT)} sha256={digest}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只校验已有包,不重新构建")
    parser.add_argument("--maintainer", help="本次打包的更新者姓名，覆盖 haminn.json 与系统用户名")
    parser.add_argument("--based-on", dest="based_on", help=f"本包所基于的包内 {BUILD_NAME} 路径")
    args = parser.parse_args()
    declared = manifest()
    package_path, output = release_info(declared)
    if not args.check:
        record = build_record(
            declared, resolve_maintainer(declared, args.maintainer), load_based_on(args.based_on), output
        )
        digest = build(output, {BUILD_NAME: encode_record(record)})
        write_install_manifest(package_path, digest)
        print(f"created {output.relative_to(ROOT)} sha256={digest} maintainer={record['maintainer']}")
    verify(package_path, output, declared)


if __name__ == "__main__":
    main()
