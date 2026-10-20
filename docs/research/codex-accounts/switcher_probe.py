"""Probe codex-auth 0.3.2-alpha.1 using synthetic accounts only (stdlib).

Usage: python3 -I switcher_probe.py /absolute/path/to/codex-auth

Creates and removes an isolated CODEX_HOME and account store. It never reads
real credentials, prints auth documents, or validates real tokens. Fake curl
and loopback proxies guard the source's external-curl HTTP path; this is not
kernel network isolation. Results describe local file behavior, not server-side
token validity or concurrent real Codex workers. A published binary matching
the version does not prove it was built from the research's pinned source SHA.

Stdout is one safe JSON summary, including on failure. Child stdout/stderr and
exception messages are never forwarded. Temporary auth/snapshots are cleaned up.
"""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

EXPECTED_VERSION = "codex-auth 0.3.2-alpha.1"
ACCOUNT_FIELDS = {
    "account_key",
    "account_name",
    "active",
    "alias",
    "auth_mode",
    "created_at",
    "email",
    "last_used_at",
    "number",
    "plan",
    "usage",
}
USAGE_FIELDS = {
    "credits",
    "primary",
    "refresh",
    "reset_credits",
    "secondary",
    "source",
    "updated_at",
}
REFRESH_FIELDS = {"error_code", "http_status", "method", "requested", "status"}


class ProbeFailure(Exception):
    """A failure whose message contains no child output or credential data."""


def require(condition):
    if not condition:
        raise ProbeFailure()


def encode_claims(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def synthetic_auth(account, generation, started_at):
    claims = {
        "email": account.lower() + "@example.invalid",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "account-" + account,
            "chatgpt_user_id": "user-" + account,
            "chatgpt_plan_type": "pro",
        },
    }
    id_token = (
        encode_claims({"alg": "none", "typ": "JWT"})
        + "."
        + encode_claims(claims)
        + ".invalid"
    )
    return {
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": None,
        "tokens": {
            "id_token": id_token,
            "access_token": f"synthetic-access-{account}-{generation}",
            "refresh_token": f"synthetic-refresh-{account}-{generation}",
            "account_id": "account-" + account,
        },
        "last_refresh": (started_at + timedelta(seconds=generation)).isoformat(),
    }


def probe(binary, root, summary):
    codex_home = root / "codex-home"
    codex_home.mkdir(mode=0o700)
    blocked_bin = root / "blocked-bin"
    blocked_bin.mkdir(mode=0o700)
    attempts = root / "network-attempts"
    fake_curl = blocked_bin / "curl"
    fake_curl.write_text(
        '#!/bin/sh\nprintf attempted >> "$HERDR_NETWORK_ATTEMPTS"\nexit 97\n'
    )
    fake_curl.chmod(0o700)

    # Start with an allowlist rather than inheriting credentials or HTTP options.
    env = {
        "CODEX_HOME": str(codex_home),
        "PATH": str(blocked_bin),
        "HERDR_NETWORK_ATTEMPTS": str(attempts),
        "LANG": "C",
        "TZ": "UTC",
        "NO_PROXY": "",
        "no_proxy": "",
    }
    for name in (
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
    ):
        env[name] = "http://127.0.0.1:9"

    def invoke(args):
        result = subprocess.run(
            [str(binary), *args],
            env=env,
            capture_output=True,
            timeout=10,
            cwd=root,
            check=False,
        )
        require(not attempts.exists())
        return result

    summary["stage"] = "version"
    version = invoke(["--version"])
    require(version.returncode == 0)
    require(version.stdout.decode().strip() == EXPECTED_VERSION)
    summary["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()

    def run(label, args, expected_exit=0):
        summary["stage"] = label
        started = time.perf_counter()
        result = invoke(args)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        require(result.returncode == expected_exit)
        document = json.loads(result.stdout)
        require(document["schema_version"] == 1)
        summary["commands"].append(
            {
                "case": label,
                "exit": result.returncode,
                "milliseconds": elapsed_ms,
                "stderr_empty": not bool(result.stderr),
            }
        )
        return document

    def write_auth(document):
        path = codex_home / "auth.json"
        path.touch(mode=0o600, exist_ok=True)
        path.write_text(json.dumps(document))

    def validate_account(account):
        require(ACCOUNT_FIELDS <= account.keys())
        require(account["auth_mode"] == "chatgpt")
        require(USAGE_FIELDS <= account["usage"].keys())
        require(REFRESH_FIELDS <= account["usage"]["refresh"].keys())
        require(account["usage"]["source"] in {"local", "cache", "none"})

    started_at = datetime.now(UTC)
    write_auth(synthetic_auth("A", 1, started_at))
    first = run("seed_a_list", ["list", "--skip-api", "--json"])
    require(first["active_account_key"] == "user-A::account-A")
    write_auth(synthetic_auth("B", 1, started_at))
    second = run("seed_b_list", ["list", "--skip-api", "--json"])
    require({"accounts", "active_account_key", "command"} <= second.keys())
    require(second["command"] == "list")
    require(len(second["accounts"]) == 2)
    require(second["active_account_key"] == "user-B::account-B")
    for account in second["accounts"]:
        validate_account(account)

    switched = run("switch_a", ["switch", "user-A::account-A", "--json"])
    require(switched["command"] == "switch")
    validate_account(switched["switched_to"])
    require(switched["switched_to"]["account_key"] == "user-A::account-A")
    require(switched["switched_to"]["active"] is True)

    rotated = synthetic_auth("A", 2, started_at)
    write_auth(rotated)
    run("switch_b_after_rotation", ["switch", "user-B::account-B", "--json"])
    run("switch_a_restore", ["switch", "user-A::account-A", "--json"])
    summary["stage"] = "rotation_preservation"
    require(json.loads((codex_home / "auth.json").read_text()) == rotated)
    summary["synthetic_rotation_preserved"] = True

    missing = run(
        "missing_key",
        ["switch", "does-not-exist", "--json"],
        expected_exit=1,
    )
    require(missing["error"]["code"] == "account_not_found")
    invalid_flag = run(
        "targeted_skip_api_rejected",
        ["switch", "user-A::account-A", "--skip-api", "--json"],
        expected_exit=2,
    )
    require(invalid_flag["error"]["code"] == "usage")
    missing_query = run(
        "query_required",
        ["switch", "--json"],
        expected_exit=2,
    )
    require(missing_query["error"]["code"] == "usage")
    for index in range(3):
        run(f"repeat_list_{index + 1}", ["list", "--skip-api", "--json"])

    summary["account_fields_checked"] = sorted(ACCOUNT_FIELDS)
    summary["usage_fields_checked"] = sorted(USAGE_FIELDS)
    summary["refresh_fields_checked"] = sorted(REFRESH_FIELDS)
    summary["network_attempts"] = 0
    summary["ok"] = True
    summary["stage"] = "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="Explicit codex-auth binary path")
    args = parser.parse_args()
    summary = {
        "ok": False,
        "stage": "setup",
        "expected_version": EXPECTED_VERSION,
        "synthetic_only": True,
        "real_account_tests": False,
        "commands": [],
    }
    try:
        binary = args.binary.resolve(strict=True)
        require(binary.is_file() and os.access(binary, os.X_OK))
        with tempfile.TemporaryDirectory(prefix="herdr-codex-accounts-") as temp_dir:
            probe(binary, Path(temp_dir), summary)
    except Exception:  # noqa: BLE001 - suppress potentially sensitive child failures
        # Exception strings, command output, file contents and temp paths may
        # contain credentials. Only report the fixed case label already set.
        summary["ok"] = False
        summary["error"] = (
            "Probe failed; child output and exception details suppressed."
        )
    print(json.dumps(summary, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
