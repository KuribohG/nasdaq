#!/usr/bin/env python3
"""Stage only public web assets, with paths compatible with /repository-name/."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "_site"
DEST.mkdir(exist_ok=True)
for name in ("assets", "data"):
    shutil.copytree(ROOT / name, DEST / name, dirs_exist_ok=True)
shutil.copy2(ROOT / "index.html", DEST / "index.html")
(DEST / ".nojekyll").touch()
if (ROOT / "CNAME").exists():
    shutil.copy2(ROOT / "CNAME", DEST / "CNAME")
print(f"Static site ready: {DEST}")
