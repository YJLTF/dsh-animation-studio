#!/usr/bin/env python3
"""修复被插件 anim/* 事件毒化的 dsh 会话日志。

背景：dsh-animation-studio 0.2.0-rc 前的构建把 `anim/*` 事件经
`session.append` 写进了宿主会话日志。dsh 的读回路径对未知事件类型
fail-closed——除非记录带 `ignorable: true` 信封，否则整个会话拒读
（「likely written by a newer harness」）。而 append API 不提供 ignorable
入口，所以这类日志必须离线修补：给 anim/* 记录补上信封标记。

物理格式（dsh-session-persistence-jsonl，一帧 = 一次 append 批次）：
- 第 0 帧必须恰好只含 header 一行（`assertZstdHeaderFrame`：明文首个 \n
  即最后一个字节），启动时的 artifact 列举就靠它读 header；
- 后续帧是事件行，行可以跨帧，但**最后一帧必须恰好结束在行边界**；
- 帧是带校验和的 zstd（Node 原生解码器会验校验和）。

因此本脚本**逐帧**处理：解出每帧明文、在行内补标记、按原帧边界逐帧回压——
帧数与行分组不变，只是改了行内容。

用法：
    python scripts/repair-session-log.py <session.v3.jsonl.zstd> [--dry-run]

行为：原文件备份为 `<原名>.bak`；只给 type 以 `anim/` 开头的完整行加
`"ignorable": true`，其余原样保留。
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import zstandard as zstd
except ImportError:
    sys.exit("需要 zstandard：pip install zstandard")


def iter_frames(data: bytes):
    """产出 (帧明文, 输入剩余)。python-zstandard 的 decompressobj 在帧尾停止，
    unused_data 即未消费的输入。"""
    dctx = zstd.ZstdDecompressor()
    pos = 0
    while pos < len(data):
        dobj = dctx.decompressobj()
        plain = dobj.decompress(data[pos:])
        consumed = len(data) - pos - len(dobj.unused_data)
        if consumed <= 0:
            raise ValueError(f"字节 {pos} 处的 zstd 帧无法解码")
        yield plain, consumed
        pos += consumed


def patch_lines(plain: bytes) -> tuple[bytes, int]:
    """补标记一帧明文里的 anim/* 完整行，返回 (新明文, 补了几行)。
    末尾若无换行的残行（torn frame），原样保留不动。"""
    head, sep, tail = plain.rpartition(b"\n")
    if not sep:
        return plain, 0  # 整帧无换行（异常但保守处理）：不动
    complete, fragment = head + b"\n", tail  # fragment 为 b"" 或无换行残行
    lines = complete.split(b"\n")[:-1]
    patched = 0
    out = []
    for line in lines:
        if b'"anim/' in line:
            try:
                record = json.loads(line)
            except ValueError:
                out.append(line)
                continue
            if str(record.get("type", "")).startswith("anim/"):
                record["ignorable"] = True
                patched += 1
                out.append(json.dumps(record, ensure_ascii=False).encode("utf-8"))
                continue
        out.append(line)
    return b"".join(l + b"\n" for l in out) + fragment, patched


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("log", type=Path, help="session.v3.jsonl.zstd 路径")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = parser.parse_args()

    raw = args.log.read_bytes()
    frames = list(iter_frames(raw))
    if not frames:
        sys.exit("空文件")
    # 启动路径的硬约束：第 0 帧恰好一行 header
    if not frames[0][0].endswith(b"\n") or frames[0][0].index(b"\n") != len(frames[0][0]) - 1:
        sys.exit("第 0 帧不是恰好一行 header——文件可能已被其他工具改坏，拒绝处理")

    compressor = zstd.ZstdCompressor(write_checksum=True)
    out = bytearray()
    total_patched = 0
    anim_types: dict[str, int] = {}
    for plain, _ in frames:
        patched_plain, n = patch_lines(plain)
        total_patched += n
        for line in patched_plain.decode("utf-8", "replace").splitlines():
            if line.strip().startswith('{"type": "anim/') or line.strip().startswith('{"type":"anim/'):
                try:
                    t = json.loads(line).get("type")
                    anim_types[t] = anim_types.get(t, 0) + 1
                except ValueError:
                    pass
        # compress() 单次调用即产出一个完整帧（write_checksum 已生效）
        out += compressor.compress(patched_plain)

    print(f"{args.log.name}: {len(frames)} 帧，其中 {total_patched} 条 anim/* 事件需要补 ignorable 标记")
    for t, c in sorted(anim_types.items()):
        print(f"  {c:4d}  {t}")
    if total_patched == 0:
        print("无需修复")
        return
    if args.dry_run:
        print("（dry-run，未写文件）")
        return

    backup = args.log.with_suffix(args.log.suffix + ".bak")
    if not backup.exists():
        backup.write_bytes(raw)
        print(f"原文件已备份：{backup}")

    tmp = args.log.with_name(args.log.name + ".tmp")
    tmp.write_bytes(bytes(out))
    tmp.replace(args.log)

    # 回读校验：帧数一致、第 0 帧恰好一行、anim 记录都带标记、行数一致
    check = list(iter_frames(args.log.read_bytes()))
    assert len(check) == len(frames), "回读帧数不一致"
    first = check[0][0]
    assert first.endswith(b"\n") and first.index(b"\n") == len(first) - 1, "回读第 0 帧不是恰好一行"
    n_marked = 0
    for plain, _ in check:
        for line in plain.decode("utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if str(record.get("type", "")).startswith("anim/"):
                assert record.get("ignorable") is True, "回读发现未标记的 anim 记录"
                n_marked += 1
    assert n_marked == total_patched, "回读标记数不一致"
    print(f"已写回 {args.log}（{len(out)} 字节，{len(check)} 帧），回读校验通过")


if __name__ == "__main__":
    main()
