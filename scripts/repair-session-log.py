#!/usr/bin/env python3
"""修复被插件 anim/* 事件毒化的 dsh 会话日志。

背景：dsh-animation-studio 0.2.0-rc 前的构建把 `anim/*` 事件经
`session.append` 写进了宿主会话日志。dsh 的读回路径对未知事件类型
fail-closed——除非记录带 `ignorable: true` 信封，否则整个会话拒读
（「likely written by a newer harness」）。而 append API 不提供 ignorable
入口，所以这类日志必须离线修补：给 anim/* 记录补上信封标记。

用法：
    python scripts/repair-session-log.py <session.v3.jsonl.zstd> [--dry-run]

行为：
- 原文件备份为 `<原名>.bak`；
- 只给 type 以 `anim/` 开头的记录加 `"ignorable": true`，其余原样保留；
- 重压缩为带校验和的 zstd 帧（与 dsh 的 JSONL 后端同形）。
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import zstandard as zstd
except ImportError:
    sys.exit("需要 zstandard：pip install zstandard")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("log", type=Path, help="session.v3.jsonl.zstd 路径")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = parser.parse_args()

    raw = args.log.read_bytes()
    text = zstd.ZstdDecompressor().decompressobj(read_across_frames=True).decompress(raw).decode("utf-8")
    lines = [line for line in text.split("\n") if line.strip()]

    patched = 0
    anim_types: dict[str, int] = {}
    out_lines: list[str] = []
    for line in lines:
        record = json.loads(line)
        if str(record.get("type", "")).startswith("anim/"):
            record["ignorable"] = True
            patched += 1
            anim_types[record["type"]] = anim_types.get(record["type"], 0) + 1
        out_lines.append(json.dumps(record, ensure_ascii=False))

    print(f"{args.log.name}: 共 {len(lines)} 条记录，其中 {patched} 条 anim/* 事件需要补 ignorable 标记")
    for t, c in sorted(anim_types.items()):
        print(f"  {c:4d}  {t}")
    if patched == 0:
        print("无需修复")
        return
    if args.dry_run:
        print("（dry-run，未写文件）")
        return

    backup = args.log.with_suffix(args.log.suffix + ".bak")
    if not backup.exists():
        backup.write_bytes(raw)
        print(f"原文件已备份：{backup}")

    # write_checksum=True：dsh 的 JSONL 后端存的是「checksummed Zstandard frames」
    compressed = zstd.ZstdCompressor(write_checksum=True).compress("\n".join(out_lines).encode("utf-8"))
    tmp = args.log.with_suffix(".zstd.tmp")
    tmp.write_bytes(compressed)
    tmp.replace(args.log)

    # 回读校验：行数一致、anim 记录都带标记
    check = zstd.ZstdDecompressor().decompressobj(read_across_frames=True).decompress(args.log.read_bytes()).decode("utf-8")
    check_lines = [line for line in check.split("\n") if line.strip()]
    assert len(check_lines) == len(lines), "回读行数不一致"
    for line in check_lines:
        record = json.loads(line)
        if str(record.get("type", "")).startswith("anim/"):
            assert record.get("ignorable") is True, "回读发现未标记的 anim 记录"
    print(f"已写回 {args.log}（{len(compressed)} 字节），回读校验通过")


if __name__ == "__main__":
    main()
