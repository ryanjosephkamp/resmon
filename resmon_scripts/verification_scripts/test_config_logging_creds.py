# resmon_scripts/verification_scripts/test_config_logging_creds.py
import sqlite3
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.database import init_db
from implementation_scripts.config_manager import save_config, load_config, delete_config, validate_config
from implementation_scripts.logger import TaskLogger, setup_app_logger
from implementation_scripts.credential_manager import store_credential, get_credential, delete_credential


def test_config_crud():
    """Save, load, and delete a configuration."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    cid = save_config(conn, "Test Config", "manual_dive", {"keywords": ["test"], "repository": "arxiv"})
    loaded = load_config(conn, cid)
    assert loaded is not None
    assert loaded["name"] == "Test Config"
    delete_config(conn, cid)
    assert load_config(conn, cid) is None
    conn.close()


def test_config_validation_rejects_invalid():
    """validate_config raises on missing required fields."""
    import pytest
    with pytest.raises(Exception):
        validate_config({})  # empty config should fail


def test_task_logger():
    """TaskLogger produces a formatted log.txt file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        log_path = Path(tmpdir) / "log.txt"
        logger = TaskLogger(log_path, operation_type="deep_dive", params={"query": "test"})
        logger.log("Query started.")
        logger.log("Found 10 results.")
        logger.finalize(status="COMPLETED", stats={"total": 10, "new": 8})
        text = log_path.read_text()
        assert "COMPLETED" in text
        assert "Query started." in text


def test_app_logger():
    """Application logger creates a rotating log file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        app_logger = setup_app_logger(Path(tmpdir))
        app_logger.info("Test log entry.")
        # Force flush
        for handler in app_logger.handlers:
            handler.flush()
        log_files = list(Path(tmpdir).glob("*.log"))
        assert len(log_files) >= 1


def test_credential_roundtrip():
    """Store and retrieve a credential via keyring."""
    test_key = "_resmon_test_credential"
    try:
        store_credential(test_key, "test_value_12345")
        retrieved = get_credential(test_key)
        assert retrieved == "test_value_12345"
    finally:
        delete_credential(test_key)
    assert get_credential(test_key) is None
