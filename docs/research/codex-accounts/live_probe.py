"""Issue #136: two real logins in a temporary home; local model responses only.

Explicit credential paths are required. Native account/read uses OpenAI's backend;
model requests go to loopback. OAuth refresh is blocked during the temporary-home
phase; --refresh-work separately uses the real authority in the work home.
Only labels, verification booleans, plan types and timings are printed. Source
auth files are unchanged unless --refresh-work explicitly requests native
refreshes in the authoritative work home. Do not use that flag while another
process is using the work login. The game is not exercised.
Run with portlease --name http (see ../codex-accounts.md).
"""

import argparse
import base64
import contextlib
import http.server
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import app_server_probe as fixture


def require(ok):
    if not ok:
        raise RuntimeError("Check failed; sensitive details suppressed")


class Handler(fixture.Handler):
    def do_POST(self):
        if self.path == "/oauth/token":
            fixture.refreshes += 1
            self.send_error(503)
        else:
            super().do_POST()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--personal-home", required=True, type=Path)
    parser.add_argument("--work-home", required=True, type=Path)
    parser.add_argument("--switcher", required=True, type=Path)
    parser.add_argument(
        "--refresh-work",
        action="store_true",
        help="Refresh the authoritative work login before and after snapshot preservation",
    )
    args = parser.parse_args()
    result = {"ok": False, "stage": "setup", "cases": [], "real_model": False}
    clients = []
    try:
        require(
            subprocess.check_output(["codex", "--version"]).strip()
            == b"codex-cli 0.163.0"
        )
        sources = {
            "personal": args.personal_home / "auth.json",
            "work": args.work_home / "auth.json",
        }
        snapshots = {label: p.read_bytes() for label, p in sources.items()}
        original_work = snapshots["work"]
        account_ids = {}
        for label, raw in snapshots.items():
            auth = json.loads(raw)
            require(auth["auth_mode"] == "chatgpt")
            tokens = auth["tokens"]
            account_ids[label] = tokens["account_id"]
            part = tokens["access_token"].split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            require(claims["exp"] > time.time() + 600)
        require(account_ids["personal"] != account_ids["work"])

        def refresh_work():
            result["stage"] = "native_work_refresh"
            before = sources["work"].read_bytes()
            native_env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith(
                    (
                        "CODEX_",
                        "OPENAI_",
                        "OTEL_",
                        "HERDR_",
                        "CLAUDE",
                        "PARALLEL_API_KEY",
                    )
                )
            }
            native_env.update(CODEX_HOME=str(args.work_home.resolve()), RUST_LOG="off")
            native = fixture.Client(args.work_home.resolve(), "", env=native_env)
            try:
                reply = native.call("account/read", {"refreshToken": True})
                require(
                    reply["workspaceRouting"]["chatgptAccountId"] == account_ids["work"]
                )
            finally:
                native.close()
            refreshed = sources["work"].read_bytes()
            old_auth, new_auth = json.loads(before), json.loads(refreshed)
            require(new_auth["tokens"]["account_id"] == account_ids["work"])
            require(new_auth["last_refresh"] > old_auth["last_refresh"])
            result["native_work_refresh_succeeded"] = True
            rotated = (
                new_auth["tokens"]["refresh_token"]
                != old_auth["tokens"]["refresh_token"]
            )
            require(rotated)
            result["refresh_token_rotated"] = rotated
            result["native_work_refresh_count"] = (
                result.get("native_work_refresh_count", 0) + 1
            )
            return refreshed

        if args.refresh_work:
            snapshots["work"] = refresh_work()
        with (
            tempfile.TemporaryDirectory(prefix="herdr-136-live-") as temp,
            contextlib.ExitStack() as cleanup,
        ):
            home = Path(temp)
            (home / "blocked-bin").mkdir()
            curl = home / "blocked-bin/curl"
            curl.write_text(
                '#!/bin/sh\nprintf attempted >> "$H3D_NETWORK_ATTEMPTS"\nexit 97\n'
            )
            curl.chmod(0o700)
            attempts = home / "network-attempts"
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith(
                    (
                        "CODEX_",
                        "OPENAI_",
                        "OTEL_",
                        "HERDR_",
                        "CLAUDE",
                        "PARALLEL_API_KEY",
                    )
                )
            }
            env.update(CODEX_HOME=str(home), RUST_LOG="off")
            switch_env = dict(
                env, PATH=str(home / "blocked-bin"), H3D_NETWORK_ATTEMPTS=str(attempts)
            )

            def cli(label, argv, expected=0):
                result["stage"] = label
                start = time.perf_counter()
                p = subprocess.run(
                    [str(args.switcher.resolve()), *argv],
                    env=switch_env,
                    cwd=home,
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                require(p.returncode == expected and not attempts.exists())
                doc = json.loads(p.stdout)
                require(doc["schema_version"] == 1)
                result["cases"].append(
                    {
                        "case": label,
                        "exit": p.returncode,
                        "milliseconds": round((time.perf_counter() - start) * 1000, 3),
                        "stderr_empty": not bool(p.stderr),
                    }
                )
                return doc

            def write(label):
                (home / "auth.json").touch(mode=0o600)
                (home / "auth.json").write_bytes(snapshots[label])

            keys = {}
            for label in ("personal", "work"):
                if label == "work" and args.refresh_work:
                    (home / "auth.json").write_bytes(original_work)
                else:
                    write(label)
                listing = cli("seed_" + label, ["list", "--skip-api", "--json"])
                keys[label] = listing["active_account_key"]
            require(len(listing["accounts"]) == 2)
            cli("missing_key", ["switch", "no-such-account", "--json"], 1)
            cli(
                "invalid_skip_api",
                ["switch", keys["personal"], "--skip-api", "--json"],
                2,
            )
            if args.refresh_work:
                write("work")  # The next valid switch must save this newer generation.
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    str(home / "key.pem"),
                    "-out",
                    str(home / "cert.pem"),
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
                    "-addext",
                    "subjectAltName=IP:127.0.0.1",
                    "-addext",
                    "basicConstraints=critical,CA:FALSE",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            srv = http.server.ThreadingHTTPServer(
                ("127.0.0.1", int(os.environ["PORTLEASE_HTTP_PORT"])), Handler
            )
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(home / "cert.pem", home / "key.pem")
            srv.socket = tls.wrap_socket(srv.socket, server_side=True)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            cleanup.callback(srv.server_close)
            cleanup.callback(srv.shutdown)
            url = "https://127.0.0.1:" + str(srv.server_port)
            env.update(
                SSL_CERT_FILE=str(home / "cert.pem"),
                CODEX_REFRESH_TOKEN_URL_OVERRIDE=url + "/oauth/token",
            )
            shutil.copyfile(
                fixture.REPO / "internal/codexshare/catalog.json", home / "catalog.json"
            )
            (home / "config.toml").write_text(f"""model = "mock"
model_provider = "mock"
model_catalog_json = {json.dumps(str(home / "catalog.json"))}
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.mock]
name = "Local real-account probe"
base_url = {json.dumps(url + "/v1")}
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"
metrics_exporter = "none"
""")

            def account(client, label, expected, refresh=False):
                result["stage"] = label
                read = client.call("account/read", {"refreshToken": refresh})
                require(
                    read["workspaceRouting"]["chatgptAccountId"]
                    == account_ids[expected]
                )
                result["cases"].append(
                    {
                        "case": label,
                        "identity_matches": True,
                        "plan": read["account"]["planType"],
                        "email_present": bool(read["account"].get("email")),
                    }
                )

            def start():
                client = fixture.Client(home, url, env=env)
                clients.append(client)
                cleanup.callback(stop, client)
                return client

            def stop(client):
                if client in clients:
                    client.close()
                    clients.remove(client)

            def thread(client, old=None):
                if old:
                    return client.call("thread/resume", {"threadId": old})["thread"][
                        "id"
                    ]
                return client.call(
                    "thread/start",
                    {
                        "cwd": str(home),
                        "model": "mock",
                        "approvalPolicy": "never",
                        "sandbox": "read-only",
                    },
                )["thread"]["id"]

            cli("switch_personal", ["switch", keys["personal"], "--json"])
            personal = start()
            account(personal, "personal_started", "personal")
            thread(personal)
            switched_at = time.monotonic()
            cli("switch_work", ["switch", keys["work"], "--json"])
            account(personal, "personal_cached_after_switch", "personal", refresh=True)
            work = start()
            account(work, "work_started", "work")
            work_thread = thread(work)
            cli("restore_personal", ["switch", keys["personal"], "--json"])
            result["switch_start_confirm_restore_seconds"] = round(
                time.monotonic() - switched_at, 3
            )
            account(work, "work_cached_after_restore", "work", refresh=True)
            fixture.mode = "ok"
            require(work.turn(work_thread)["status"] == "completed")
            fixture.mode = "unauthorized"
            failed = work.turn(work_thread)
            require(
                failed["status"] == "failed"
                and "another account" in failed["error"]["message"]
            )
            result["controlled_401_failed_with_account_mismatch"] = True
            stop(work)
            restarted = start()
            account(restarted, "restarted_with_personal_active", "personal")
            thread(restarted, work_thread)
            account(restarted, "resumed_work_thread_on_personal", "personal")
            if args.refresh_work:
                cli("rotation_switch_back_work", ["switch", keys["work"], "--json"])
                require((home / "auth.json").read_bytes() == snapshots["work"])
                account(start(), "rotated_work_snapshot_valid", "work")
                result["real_rotated_snapshot_preserved"] = True
                cli("rotation_restore_personal", ["switch", keys["personal"], "--json"])
            require(fixture.refreshes == 0)
            require(
                json.loads((home / "auth.json").read_bytes())["tokens"]["account_id"]
                == account_ids["personal"]
            )
            result["oauth_refresh_requests"] = fixture.refreshes
            result["switcher_network_attempts"] = 0
            result["source_auth_files_unchanged_during_temporary_phase"] = all(
                p.read_bytes() == snapshots[label] for label, p in sources.items()
            )
            require(result["source_auth_files_unchanged_during_temporary_phase"])
            if args.refresh_work:
                # The restored snapshot matched the authoritative work file byte for
                # byte. Close clones before spending that same refresh token in its
                # authoritative home, which keeps the user's login current.
                while clients:
                    stop(clients[-1])
                snapshots["work"] = refresh_work()
                result["restored_refresh_token_accepted"] = True
                require(sources["work"].read_bytes() == snapshots["work"])
            result["personal_auth_unchanged"] = (
                sources["personal"].read_bytes() == snapshots["personal"]
            )
            result["ok"] = True
            result["stage"] = "complete"
    except Exception:  # noqa: BLE001 - never forward real credentials or child diagnostics
        result["error"] = "Live probe failed; sensitive details suppressed"
    finally:
        for client in clients:
            client.close()
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
