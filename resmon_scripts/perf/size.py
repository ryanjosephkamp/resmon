"""How big resmon is: the renderer bundle, the installed app, and the installer."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from .stats import metric


def tree_bytes(path: Path) -> int:
    """Bytes in every file under ``path``, symlinks not followed, each inode once.

    Apparent size, not blocks allocated: a person reads an app's size as the
    sum of its files, and APFS clones and compression would otherwise make the
    same app measure differently on two machines.
    """
    path = Path(path)
    if path.is_file():
        return path.stat().st_size
    total, seen = 0, set()
    for root, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(root, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if (st.st_dev, st.st_ino) in seen:
                continue
            seen.add((st.st_dev, st.st_ino))
            total += st.st_size
    return total


def _mb(n: int) -> float:
    return n / (1024 * 1024)


def measure(frontend: Path, app_bundle: Optional[Path], installers: list[Path]) -> list[dict]:
    out = [metric("size.renderer_bundle", "MB", [_mb(tree_bytes(frontend / "dist"))],
                  note="frontend/dist: the built renderer and Electron main process.")]
    if app_bundle is not None and app_bundle.exists():
        out.append(metric("size.installed_app", "MB", [_mb(tree_bytes(app_bundle))],
                          note=f"{app_bundle.name}, unpacked, as it sits in /Applications."))
        resources = app_bundle / "Contents" / "Resources"
        parts = {
            "electron_frameworks": app_bundle / "Contents" / "Frameworks",
            "backend_runtime": resources / "backend" / "python",
            "backend_source": resources / "backend" / "resmon_scripts",
            "app_asar": resources / "app.asar",
        }
        for label, part in parts.items():
            if part.exists():
                out.append(metric(f"size.installed_app.{label}", "MB", [_mb(tree_bytes(part))]))
        site = resources / "backend" / "python" / "lib"
        google = next(site.glob("python3*/site-packages/googleapiclient"), None) if site.exists() else None
        if google is not None:
            out.append(metric("size.installed_app.googleapiclient", "MB", [_mb(tree_bytes(google))],
                              note="The Google API client library, whose discovery documents are most of it."))
    for installer in installers:
        out.append(metric(f"size.installer.{installer.suffix.lstrip('.')}", "MB",
                          [_mb(installer.stat().st_size)], note=installer.name))
    return out
