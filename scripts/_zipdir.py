"""用 zipfile 将 srcDir 打成 outZip（跨平台，无外部依赖）。"""
import sys
import zipfile
import os

src = sys.argv[1]
out = sys.argv[2]

base_name = os.path.basename(src)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.relpath(full, os.path.dirname(src))  # 含顶层目录名
            zf.write(full, arc)
            print(f"  + {arc}")
