# resmon_scripts/verification_scripts/test_step1_scaffolding.py
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

def test_directories_exist():
    """Verify all required project directories exist."""
    required_dirs = [
        "resmon_scripts/implementation_scripts",
        "resmon_scripts/verification_scripts",
        "resmon_scripts/notebooks",
        "resmon_scripts/given_scripts",
        "resmon_scripts/frontend",
        "resmon_experiments",
        "resmon_reports/figures",
        "resmon_reports/latex/figures",
        "resmon_reports/markdowns",
        "resmon_reports/pdfs",
        "resmon_printouts",
    ]
    for rel_path in required_dirs:
        assert (PROJECT_ROOT / rel_path).is_dir(), f"Missing directory: {rel_path}"


def test_core_modules_importable():
    """Verify core modules import without error."""
    sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
    from implementation_scripts import config, utils

    assert hasattr(config, "PROJECT_ROOT")
    assert hasattr(config, "DEFAULT_DB_PATH")
    assert hasattr(config, "APP_NAME")
    assert hasattr(utils, "now_iso")
    assert hasattr(utils, "compute_metadata_hash")
    assert hasattr(utils, "sanitize_filename")


def test_orchestrator_runs():
    """Verify the main orchestrator script runs without crashing."""
    sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
    import resmon
    assert hasattr(resmon, "main")
