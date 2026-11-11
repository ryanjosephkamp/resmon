"""Build ``resmon.pyz``, the command line that ships inside the app.

    python build_pyz.py OUTPUT APP_VERSION

Packs ``resmon_cli`` with the standard library's ``zipapp`` (it has no
dependencies) and writes ``resmon_cli/_build.py`` into the archive, which is how
``resmon --version`` knows it is the app's command line and which version of the
app it belongs to. The package in this folder is not changed.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import zipapp
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent / "resmon_cli"


def build(output: Path, app_version: str) -> None:
    with tempfile.TemporaryDirectory() as scratch:
        staged = Path(scratch) / "resmon_cli"
        shutil.copytree(PACKAGE, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "_build.py"))
        (staged / "_build.py").write_text(f"APP_VERSION = {app_version!r}\n", encoding="utf-8")
        output.parent.mkdir(parents=True, exist_ok=True)
        zipapp.create_archive(scratch, output, main="resmon_cli.main:run", compressed=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: build_pyz.py OUTPUT APP_VERSION")
    build(Path(sys.argv[1]), sys.argv[2])
