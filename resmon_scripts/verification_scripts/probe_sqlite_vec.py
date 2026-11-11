#!/usr/bin/env python3
"""Probe this interpreter, one sqlite-vec binary, and optional packaged resources.

Run with the shipped Python and -I (isolated mode), not the development venv.
This uses an in-memory database and never imports resmon. Exit 1 means a requested
check failed; exit 0 without --resources-dir does NOT establish packaging.
Direct invocation cannot establish Finder/Gatekeeper or Electron-launch behavior.
"""

import argparse
import hashlib
import importlib
import json
import math
from pathlib import Path
import platform
import sys
import sysconfig


def probe(args: argparse.Namespace) -> tuple[dict[str, object], int]:
    """Keep loading support, binary compatibility, and packaging evidence separate."""
    support: dict[str, object] = {"status": "not_tested"}
    binary: dict[str, object] = {"status": "not_found", "load_status": "not_tested"}
    packaged: dict[str, object] = {
        "status": "not_tested",
        "scope": "direct invocation of the interpreter in packaged resources",
        "not_established": ["Electron launch", "Gatekeeper/app translocation", "notarization"],
    }
    query: dict[str, object] = {"status": "not_tested"}
    runtime = Path(sys.prefix).resolve()
    marker = runtime / ".resmon-runtime"
    report: dict[str, object] = {
        "python": sys.version,
        "executable": str(Path(sys.executable).resolve()),
        "prefix": str(runtime),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "isolated": bool(sys.flags.isolated),
        "configure_args": sysconfig.get_config_var("CONFIG_ARGS"),
        "extension_loading": support,
        "binary": binary,
        "packaged_app": packaged,
        "vector_query": query,
    }
    failed = False
    connection = None
    extension = None

    try:
        sqlite3 = importlib.import_module("sqlite3")
        report["sqlite_version"] = sqlite3.sqlite_version
        native = importlib.import_module("_sqlite3")
        # python-build-standalone can compile _sqlite3 into the interpreter;
        # such a module has no __file__, which is not a loading-support failure.
        native_file = getattr(native, "__file__", None)
        report["sqlite_module"] = str(Path(native_file).resolve()) if native_file else native.__spec__.origin
        report["sqlite_builtin"] = "_sqlite3" in sys.builtin_module_names
        connection = sqlite3.connect(":memory:")
        report["sqlite_compile_options"] = [row[0] for row in connection.execute("PRAGMA compile_options")]
        connection.enable_load_extension(True)
        connection.enable_load_extension(False)
        support.update(status="pass", evidence="enable_load_extension(True), then False, returned normally")
    except Exception as exc:
        support.update(status="fail", error=f"{type(exc).__name__}: {exc}")
        failed = True

    # Discover the actual file, not just a wheel tag: only loading can establish
    # compatibility with this interpreter's SQLite and the current OS/CPU.
    try:
        if args.extension:
            extension = args.extension.resolve(strict=True)
            binary["origin"] = "explicit --extension"
        else:
            module = importlib.import_module("sqlite_vec")
            suffix = {"darwin": ".dylib", "win32": ".dll"}.get(sys.platform, ".so")
            extension = Path(module.loadable_path() + suffix).resolve(strict=True)
            binary["package_version"] = module.__version__
            binary["module_path"] = str(Path(module.__file__).resolve())
        payload = extension.read_bytes()
        binary.update(status="found", path=str(extension), bytes=len(payload),
                      sha256=hashlib.sha256(payload).hexdigest())
    except Exception as exc:
        binary["error"] = f"{type(exc).__name__}: {exc}"
        binary["availability_scope"] = "this interpreter only; upstream availability not checked"
        failed = True

    try:
        pin = marker.read_text().strip() if marker.is_file() else None
        report["runtime_pin"] = pin
        if args.expected_runtime_pin and pin != args.expected_runtime_pin:
            raise ValueError(f"runtime pin {pin!r} != {args.expected_runtime_pin!r}")
        if args.resources_dir:
            resources = args.resources_dir.resolve(strict=True)
            if not (resources / "app.asar").is_file():
                raise ValueError("app.asar missing: staged backend files alone do not establish packaging")
            expected_runtime = (resources / "backend" / "python").resolve(strict=True)
            if runtime != expected_runtime or Path(sys.base_prefix).resolve() != runtime:
                raise ValueError("interpreter prefix is not the standalone packaged runtime")
            contained = [Path(sys.executable).resolve()]
            if not report.get("sqlite_builtin"):
                contained.append(Path(str(report["sqlite_module"])))
            if extension is None:
                raise ValueError("no binary to verify inside packaged resources")
            contained.append(extension)
            if "module_path" in binary:
                contained.append(Path(str(binary["module_path"])))
            if not pin or not all(p.is_relative_to(runtime) for p in contained):
                raise ValueError("runtime marker missing or interpreter/module/binary escapes packaged runtime")
            if not sys.flags.isolated:
                raise ValueError("packaged checks require Python -I to exclude PYTHONPATH and user site packages")
            packaged.update(status="paths_verified", resources_dir=str(resources))
    except Exception as exc:
        packaged.update(status="fail", error=f"{type(exc).__name__}: {exc}")
        failed = True

    if connection is not None and support["status"] == "pass" and binary["status"] == "found":
        try:
            connection.enable_load_extension(True)
            try:
                connection.load_extension(str(extension))
            finally:
                connection.enable_load_extension(False)
            binary["load_status"] = "pass"
            version = connection.execute("SELECT vec_version()").fetchone()[0]
            binary["vec_version"] = version
            if args.expected_version and version.lstrip("v") != args.expected_version:
                raise ValueError(f"vec_version() {version!r} != {args.expected_version!r}")

            # Exercise the virtual table and nearest-neighbor path, not just
            # vec_version(): a successful dlopen alone does not prove a query.
            connection.execute("CREATE VIRTUAL TABLE probe_vectors USING vec0(embedding float[3])")
            connection.executemany(
                "INSERT INTO probe_vectors(rowid, embedding) VALUES (?, ?)",
                [(1, "[1,2,3]"), (2, "[3,2,1]"), (3, "[10,10,10]")],
            )
            sql = "SELECT rowid, distance FROM probe_vectors WHERE embedding MATCH ? AND k = 2 ORDER BY distance"
            rows = connection.execute(sql, ("[1,2,3]",)).fetchall()
            query.update(sql=sql, parameter="[1,2,3]", rows=rows)
            if (len(rows) != 2 or [row[0] for row in rows] != [1, 2]
                    or not math.isclose(rows[0][1], 0.0, abs_tol=1e-6)
                    or not math.isclose(rows[1][1], math.sqrt(8), rel_tol=1e-6)):
                raise ValueError(f"unexpected nearest-neighbor result: {rows!r}")
            query["status"] = "pass"
        except Exception as exc:
            if binary["load_status"] != "pass":
                binary["load_status"] = "fail"
            query.update(status="fail", error=f"{type(exc).__name__}: {exc}")
            failed = True
    if connection is not None:
        connection.close()
    if packaged["status"] == "paths_verified":
        packaged["status"] = "pass" if query["status"] == "pass" else "fail"
    report["exit_code"] = int(failed)
    return report, int(failed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, help="exact native binary; defaults to installed sqlite_vec")
    parser.add_argument("--resources-dir", type=Path, help="packaged Contents/Resources or resources directory")
    parser.add_argument("--expected-version", help="fail if vec_version() differs (e.g. 0.1.9)")
    parser.add_argument("--expected-runtime-pin", help="require this .resmon-runtime marker")
    args = parser.parse_args()
    report, code = probe(args)
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
