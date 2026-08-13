#!/usr/bin/env python3

import re
import sys


def format_release_notes(markdown: str) -> str:
    notes = re.split(
        r"(?m)^#{1,6}\s*(?:分发说明|按系统下载)\s*$",
        markdown,
        maxsplit=1,
    )[0]
    notes = re.sub(
        r"\[([^\]]+)\]\((https?://[^)]+)\)",
        lambda match: f"{match.group(1)}：{match.group(2)}",
        notes,
    )
    notes = re.sub(r"(?m)^#{1,6}\s+", "", notes)
    notes = re.sub(r"(?m)^\s*[-*+]\s+", "• ", notes)
    notes = re.sub(r"\*\*([^*]+)\*\*", r"\1", notes)
    notes = re.sub(r"__([^_]+)__", r"\1", notes)
    notes = re.sub(r"`([^`]+)`", r"\1", notes)
    notes = re.sub(r"[ \t]+$", "", notes, flags=re.MULTILINE)
    notes = re.sub(r"\n{3,}", "\n\n", notes)
    return notes.strip()


if __name__ == "__main__":
    markdown = sys.stdin.buffer.read().decode("utf-8")
    sys.stdout.buffer.write(format_release_notes(markdown).encode("utf-8"))
