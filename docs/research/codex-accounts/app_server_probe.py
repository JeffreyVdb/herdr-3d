"""Issue #136: installed Codex + synthetic accounts + loopback inference only.

Run from the repository root via portlease (see ../codex-accounts.md).
Requires Python 3, openssl and codex-cli 0.163.0. Never reads real credentials.
"""

import base64
import datetime as dt
import http.server
import json
import os
import queue
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
seen = []
mode = "ok"
refreshes = 0


def jwt(claims):
    enc = lambda v: (
        base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip("=")
    )
    return enc({"alg": "none"}) + "." + enc(claims) + ".fixture"


def auth(account, exp=None):
    claims = {
        "email": account.lower() + "@example.invalid",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": account,
            "chatgpt_plan_type": "plus",
        },
    }
    access = dict(claims, exp=exp or int(time.time()) + 86400)
    return {
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": jwt(claims),
            "access_token": jwt(access),
            "refresh_token": "fixture-only-" + account,
            "account_id": account,
        },
        "last_refresh": dt.datetime.now(dt.UTC).isoformat(),
    }


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        self.send_error(403)

    def do_GET(self):
        if "/accounts/check" in self.path:
            body = json.dumps(
                {
                    "accounts": [
                        {
                            "id": a,
                            "workspace_backend_origin": "NO_CONSTRAINT",
                            "account_routing_override": "NO_CONSTRAINT",
                        }
                        for a in ["A", "B"]
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        global refreshes
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/oauth/token":
            refreshes += 1
            body = json.dumps(auth("A")["tokens"]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path != "/v1/responses":
            self.send_error(404)
            return
        seen.append(
            {"path": self.path, "account": self.headers.get("ChatGPT-Account-ID")}
        )
        if mode == "unauthorized":
            body = b'{"error":{"message":"fixture unauthorized","type":"invalid_request_error"}}'
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in [
            {
                "type": "response.created",
                "response": {"id": "fixture", "status": "in_progress", "output": []},
            },
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "type": "message",
                    "id": "msg",
                    "role": "assistant",
                    "content": [],
                },
            },
            {
                "type": "response.output_text.delta",
                "item_id": "msg",
                "output_index": 0,
                "content_index": 0,
                "delta": "OK",
            },
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "type": "message",
                    "id": "msg",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "OK"}],
                },
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "fixture",
                    "status": "completed",
                    "output": [],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                },
            },
        ]:
            self.wfile.write(
                (
                    "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                ).encode()
            )


class Client:
    def __init__(self, home, url, env=None):
        self.q = queue.Queue()
        self.notes = []
        self.n = 0
        env = self.fixture_env(home, url) if env is None else env
        self.p = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
            cwd=home,
        )

        def read():
            for line in self.p.stdout:
                try:
                    self.q.put(json.loads(line))
                except ValueError:
                    pass

        threading.Thread(target=read, daemon=True).start()
        try:
            self.call(
                "initialize",
                {"clientInfo": {"name": "herdr-136-probe", "version": "1"}},
            )
            self.send({"method": "initialized"})
        except (RuntimeError, queue.Empty, OSError):
            self.close()
            raise

    @staticmethod
    def fixture_env(home, url):
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(
                ("CODEX_", "OPENAI_", "OTEL_", "HERDR_", "CLAUDE", "PARALLEL_API_KEY")
            )
        }
        env.update(
            CODEX_HOME=str(home),
            CODEX_REFRESH_TOKEN_URL_OVERRIDE=url + "/oauth/token",
            SSL_CERT_FILE=str(home / "cert.pem"),
            RUST_LOG="off",
        )
        for name in (
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
        ):
            env[name] = url
        for name in ("NO_PROXY", "no_proxy"):
            env[name] = "localhost,127.0.0.1"
        return env

    def send(self, value):
        self.p.stdin.write(json.dumps(value) + "\n")
        self.p.stdin.flush()

    def call(self, method, params):
        self.n += 1
        self.send({"id": self.n, "method": method, "params": params})
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            msg = self.q.get(timeout=max(0.01, deadline - time.monotonic()))
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(method + " failed; server details suppressed")
                return msg["result"]
            self.notes.append(msg)
        raise TimeoutError(method)

    def turn(self, thread):
        self.call(
            "turn/start",
            {"threadId": thread, "input": [{"type": "text", "text": "Reply OK."}]},
        )
        while True:
            msg = self.q.get(timeout=25)
            self.notes.append(msg)
            if msg.get("method") == "turn/completed":
                return msg["params"]["turn"]

    def close(self):
        self.p.terminate()
        try:
            self.p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
        self.p.stdin.close()
        self.p.stdout.close()


def main():
    global mode
    version = subprocess.check_output(["codex", "--version"], text=True).strip()
    assert version == "codex-cli 0.163.0", (
        "This probe was verified only with codex-cli 0.163.0"
    )
    print("version", version)
    with tempfile.TemporaryDirectory(prefix="herdr-136-") as tmp:
        home = Path(tmp)
        shutil.copyfile(
            REPO / "internal/codexshare/catalog.json", home / "catalog.json"
        )
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
        url = "https://127.0.0.1:" + str(srv.server_port)
        (home / "config.toml").write_text(f"""model = "mock"
model_provider = "mock"
model_catalog_json = {json.dumps(str(home / "catalog.json"))}
chatgpt_base_url = {json.dumps(url)}
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.mock]
name = "Local auth probe"
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

        def write(account, exp=None):
            (home / "auth.json").write_text(json.dumps(auth(account, exp)))
            (home / "auth.json").chmod(0o600)

        write("A")
        c = Client(home, url)
        try:
            print(
                "initial", json.dumps(c.call("account/read", {"refreshToken": False}))
            )
            th = c.call(
                "thread/start",
                {
                    "cwd": str(home),
                    "model": "mock",
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                },
            )["thread"]["id"]
            write("B")
            print(
                "after_disk_switch",
                json.dumps(c.call("account/read", {"refreshToken": False})),
            )
            print(
                "after_forced_refresh",
                json.dumps(c.call("account/read", {"refreshToken": True})),
            )
            turn = c.turn(th)
            assert turn["status"] == "completed"
            print(
                "normal_turn",
                json.dumps(
                    {
                        "status": turn["status"],
                        "accounts": sorted(
                            {v["account"] for v in seen if v["account"]}
                        ),
                    }
                ),
            )
            mode = "unauthorized"
            turn = c.turn(th)
            assert (
                turn["status"] == "failed"
                and turn["error"]["codexErrorInfo"] == "unauthorized"
            )
            assert "another account" in turn["error"]["message"] and refreshes == 0
            errors = [
                m["params"].get("error", {})
                for m in c.notes
                if m.get("method") == "error"
            ]
            print(
                "unauthorized_turn",
                json.dumps(
                    {
                        "status": turn["status"],
                        "turn_error": turn.get("error"),
                        "errors": errors,
                        "refresh_requests": refreshes,
                    }
                ),
            )
            # thread/read flushes the persisted rollout before reading it.
            c.call("thread/read", {"threadId": th, "includeTurns": True})
        finally:
            c.close()
        notices = []
        terminal = []
        for path in (home / "sessions").rglob("*.jsonl"):
            for line in path.read_text().splitlines():
                r = json.loads(line)
                p = r.get("payload", {})
                if r.get("type") == "event_msg" and p.get("type") in (
                    "error",
                    "stream_error",
                    "warning",
                ):
                    notices.append({"type": p["type"], "message": p.get("message")})
                if r.get("type") == "event_msg" and p.get("type") == "task_complete":
                    terminal.append({"type": p["type"], "error": p.get("error")})
        print("rollout_errors", json.dumps(notices))
        print("rollout_terminal", json.dumps(terminal))
        assert not notices
        assert any(
            t["error"] and "another account" in t["error"]["message"] for t in terminal
        )
        c = Client(home, url)
        try:
            print(
                "restarted_on_disk_B",
                json.dumps(c.call("account/read", {"refreshToken": False})),
            )
            c.call("thread/resume", {"threadId": th})
            print(
                "resumed_on_disk_B",
                json.dumps(c.call("account/read", {"refreshToken": False})),
            )
            write("A")
            print(
                "B_after_switch_back_A",
                json.dumps(c.call("account/read", {"refreshToken": False})),
            )
            mode = "ok"
            turn = c.turn(th)
            assert turn["status"] == "completed"
            print("B_normal_after_switch_back", json.dumps({"status": turn["status"]}))
            mode = "unauthorized"
            turn = c.turn(th)
            assert (
                turn["status"] == "failed"
                and "another account" in turn["error"]["message"]
            )
            print(
                "B_unauthorized_after_switch_back",
                json.dumps({"status": turn["status"], "turn_error": turn.get("error")}),
            )
        finally:
            c.close()
        for name, expires, old_refresh in [
            ("near_expiry", 240, False),
            ("outside_window_old_last_refresh", 360, True),
            ("opaque_access_old_last_refresh", None, True),
        ]:
            a = auth("A", int(time.time()) + expires if expires else None)
            if old_refresh:
                a["last_refresh"] = (
                    dt.datetime.now(dt.UTC) - dt.timedelta(days=9)
                ).isoformat()
            if expires is None:
                a["tokens"]["access_token"] = "fixture-opaque"
            (home / "auth.json").write_text(json.dumps(a))
            before = refreshes
            c = Client(home, url)
            try:
                c.call("account/read", {"refreshToken": False})
                mode = "ok"
                th2 = c.call(
                    "thread/start",
                    {
                        "cwd": str(home),
                        "model": "mock",
                        "approvalPolicy": "never",
                        "sandbox": "read-only",
                    },
                )["thread"]["id"]
                c.turn(th2)
                expected = 0 if name == "outside_window_old_last_refresh" else 1
                assert refreshes - before == expected
                print(name, json.dumps({"refresh_requests": refreshes - before}))
            finally:
                c.close()
        print("refresh_requests_total", refreshes)
    srv.shutdown()
    srv.server_close()


if __name__ == "__main__":
    main()
