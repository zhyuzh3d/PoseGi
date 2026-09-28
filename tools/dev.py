#!/usr/bin/env python3
"""把当前 happ 热同步到设备开发工作区(智能体开发模式)。

用法:
    python3 tools/dev.py --address http://192.168.124.28:8766
    HAMINN_ADDRESS=http://192.168.124.28:8766 python3 tools/dev.py

它包的是 haminn-agent.py 的 develop-dir:初始化一次 DEV 工作区,之后持续监听本地
改动并按批同步,改一个文件就能在手机上看到一次,不递增版本号、不打包。

地址与密码都来自手机 Haminn 的「开发配置」,本脚本不存密码:
密码请先用 haminn-agent.py connect 存好一次(见 README)。
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_AGENTS = (
    pathlib.Path.home() / ".workbuddy/skills/haminn-dev-plugin/haminn-agent.py",
    pathlib.Path.home() / "plugins/haminn-dev-plugin/haminn-agent.py",
)


def find_agent(explicit: str | None) -> pathlib.Path:
    if explicit:
        candidate = pathlib.Path(explicit).expanduser()
        if not candidate.is_file():
            raise SystemExit(f"找不到 haminn-agent.py: {candidate}")
        return candidate
    from_env = os.environ.get("HAMINN_AGENT")
    if from_env:
        candidate = pathlib.Path(from_env).expanduser()
        if candidate.is_file():
            return candidate
        raise SystemExit(f"HAMINN_AGENT 指向的文件不存在: {candidate}")
    for candidate in DEFAULT_AGENTS:
        if candidate.is_file():
            return candidate
    raise SystemExit(
        "找不到 haminn-agent.py。请用 --agent /path/to/haminn-agent.py 指定,"
        "或设置 HAMINN_AGENT 环境变量。"
    )


def resolve_address(explicit: str | None) -> str:
    value = explicit or os.environ.get("HAMINN_ADDRESS") or ""
    if not value:
        raise SystemExit(
            "缺少设备地址。请在手机 Haminn 的「开发配置」里看当前地址,"
            "用 --address http://PHONE:8766 传入,或设置 HAMINN_ADDRESS。"
        )
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--address", help="手机开发配置里显示的地址,含端口")
    parser.add_argument("--agent", help="haminn-agent.py 的路径")
    parser.add_argument("--app-id", help="同一 happId 装了多个实例时才需要")
    parser.add_argument("--sync-policy", choices=("client", "device", "download", "continue"),
                        help="首次整树同步的方向;不确定时先不要传")
    parser.add_argument("--verbose", action="store_true", help="打印每次保存的输出")
    args = parser.parse_args()

    agent = find_agent(args.agent)
    address = resolve_address(args.address)

    command = [sys.executable, str(agent), "--address", address, "develop-dir", str(ROOT)]
    if not args.verbose:
        command.append("--quiet")
    if args.app_id:
        command.extend(["--app-id", args.app_id])
    if args.sync_policy:
        command.extend(["--sync-policy", args.sync_policy])

    print(f"同步 {ROOT} → {address}(Ctrl+C 结束)", flush=True)
    try:
        return os.spawnv(os.P_WAIT, sys.executable, command)
    except KeyboardInterrupt:
        print("\n已停止监听。", flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
