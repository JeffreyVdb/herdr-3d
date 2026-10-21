#!/usr/bin/env python3
"""Probe an isolated Herdr controller; never attach to an existing session.

Usage: python3 herdr-probe.py [--out results.json]
Only synthetic output is collected. Every Herdr invocation uses a fresh named
session and isolated XDG directories; cleanup runs even when an assertion fails.
"""

import argparse
import base64
import json
import os
from pathlib import Path
import queue
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tty
import uuid


def fixture():
    tty.setraw(0)
    os.write(1, b"HERDR_PROBE_READY\r\n")
    while True:
        data = os.read(0, 4096)
        if not data or b"q" in data:
            return
        for byte in data:
            if byte == ord("s"):
                size = os.get_terminal_size(0)
                os.write(1, f"\r\nPROBE_SIZE={size.columns}x{size.lines}\r\n".encode())
            elif byte == ord("h"):
                os.write(1, b"".join(f"history-{n:03d}\r\n".encode() for n in range(100)))
                os.write(1, b"\x1b]8;;https://example.com/herdr-probe\x1b\\PROBE_LINK\x1b]8;;\x1b\\\r\nHISTORY_READY\r\n")
            elif byte == ord("m"):
                os.write(1, b"\x1b[?1000h\x1b[?1006hMOUSE_MODES_ENABLED\r\n")


class Stream:
    def __init__(self, command, env, log):
        self.proc = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=log, text=True)
        self.records = []
        self.pending = queue.Queue()
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        for line in self.proc.stdout:
            record = json.loads(line)
            self.records.append(record)
            self.pending.put(record)

    def send(self, **record):
        self.proc.stdin.write(json.dumps(record) + "\n")
        self.proc.stdin.flush()

    def wait(self, predicate, timeout=8):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                record = self.pending.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty:
                break
            if predicate(record):
                return record
        last = frame_bytes(self.records[-1])[-1500:] if self.records else b""
        raise AssertionError(f"No matching stream record; process exit={self.proc.poll()}; "
                             f"last ANSI={last!r}")

    def close(self):
        if self.proc.poll() is None:
            try:
                self.send(type="terminal.release")
                self.proc.wait(timeout=2)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
        self.thread.join(timeout=2)


def frame_bytes(record):
    return base64.b64decode(record.get("bytes", ""))


def probe():
    binary = shutil.which("herdr")
    if not binary:
        raise SystemExit("herdr must be installed")
    result = {"version": subprocess.check_output([binary, "--version"], text=True).strip()}
    with tempfile.TemporaryDirectory(prefix="h3d-herdr-probe-") as temp:
        root = Path(temp)
        name = "h3d-terminal-probe-" + uuid.uuid4().hex[:8]
        env = {k: v for k, v in os.environ.items() if not k.startswith(("HERDR_", "CLAUDE"))}
        for key, child in [("XDG_CONFIG_HOME", "config"), ("XDG_STATE_HOME", "state"),
                           ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")]:
            directory = root / child
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        launcher = root / "fixture-shell"
        launcher.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " +
                            shlex.quote(str(Path(__file__).resolve())) + " --fixture\n")
        launcher.chmod(0o700)
        config = root / "config.toml"
        config.write_text("onboarding = false\n[terminal]\ndefault_shell = " +
                          json.dumps(str(launcher)) + '\nshell_mode = "non_login"\n')
        env["HERDR_CONFIG_PATH"] = str(config)
        prefix = [binary, "--session", name]

        def cli(*args, check=True):
            done = subprocess.run(prefix + list(args), env=env, capture_output=True,
                                  text=True, timeout=10, check=check)
            if done.returncode != 0:
                return None
            return json.loads(done.stdout) if done.stdout.strip() else {}

        streams = []
        with (root / "server.log").open("w") as log:
            server = subprocess.Popen(prefix + ["server"], env=env, cwd=root,
                                      stdout=log, stderr=log, start_new_session=True)
            try:
                end = time.monotonic() + 10
                while cli("workspace", "list", check=False) is None:
                    if server.poll() is not None or time.monotonic() > end:
                        raise AssertionError("Isolated server failed to start")
                    time.sleep(0.1)
                created = cli("workspace", "create", "--cwd", str(root), "--no-focus")
                pane = created["result"]["root_pane"]["pane_id"]
                observer = Stream(prefix + ["terminal", "session", "observe", pane,
                                            "--cols", "60", "--rows", "12"], env, log)
                streams.append(observer)
                observer.wait(lambda r: b"HERDR_PROBE_READY" in frame_bytes(r))
                cli("pane", "send-text", pane, "s")
                observer.wait(lambda r: b"PROBE_SIZE=" in frame_bytes(r))
                result["observer_requested"] = "60x12"
                raw = b"".join(frame_bytes(r) for r in observer.records)
                initial_size = re.search(rb"PROBE_SIZE=(\d+x\d+)", raw)
                result["observer_actual_pty"] = initial_size.group(1).decode() if initial_size else None
                result["observer_did_not_resize_pty"] = initial_size is not None and result["observer_actual_pty"] != "60x12"
                observer.close()

                controller = Stream(prefix + ["terminal", "session", "control", pane,
                                              "--cols", "80", "--rows", "24"], env, log)
                streams.append(controller)
                controller.wait(lambda r: r.get("type") == "terminal.frame")
                controller.send(type="terminal.input", text="s")
                controller.wait(lambda r: b"PROBE_SIZE=80x24" in frame_bytes(r))
                result["controller_resized_pty"] = "80x24"
                controller.send(type="terminal.resize", cols=110, rows=31)
                controller.wait(lambda r: r.get("width") == 110 and r.get("height") == 31)
                controller.send(type="terminal.input", bytes=base64.b64encode(b"s").decode())
                controller.wait(lambda r: b"PROBE_SIZE=110x31" in frame_bytes(r))
                result["resize_command_changed_pty"] = "110x31"
                controller.send(type="terminal.input", text="h")
                controller.wait(lambda r: b"HISTORY_READY" in frame_bytes(r))
                raw = b"".join(frame_bytes(r) for r in controller.records)
                result["osc8_preserved"] = b"\x1b]8;;https://example.com/herdr-probe" in raw
                result["scroll_before"] = cli("pane", "get", pane)["result"]["pane"].get("scroll")
                controller.send(type="terminal.scroll", direction="up", lines=12)
                controller.wait(lambda r: b"history-" in frame_bytes(r))
                result["scroll_after"] = cli("pane", "get", pane)["result"]["pane"].get("scroll")
                assert result["scroll_after"]["offset_from_bottom"] == 12
                controller.send(type="terminal.input", text="m")
                controller.wait(lambda r: b"MOUSE_MODES_ENABLED" in frame_bytes(r))
                raw = b"".join(frame_bytes(r) for r in controller.records)
                result["mouse_modes_forwarded"] = any(mode in raw for mode in [b"\x1b[?1000h", b"\x1b[?1006h"])
                result["output_record_types"] = sorted({r["type"] for r in controller.records})
                second = Stream(prefix + ["terminal", "session", "control", pane,
                                          "--cols", "80", "--rows", "24"], env, log)
                streams.append(second)
                closed = second.wait(lambda r: r.get("type") == "terminal.closed")
                result["second_controller_refused"] = "already has an attached client" in closed.get("reason", "")
                result["controller_frame_count"] = sum(r["type"] == "terminal.frame" for r in controller.records)
                result["controller_ansi_bytes"] = len(raw)
                assert result["observer_did_not_resize_pty"] and result["osc8_preserved"], result
                assert result["second_controller_refused"] and not result["mouse_modes_forwarded"]
            finally:
                for stream in streams:
                    stream.close()
                stopped = subprocess.run([binary, "session", "stop", name, "--json"], env=env,
                                         capture_output=True, text=True, timeout=10)
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.terminate()
                    server.wait(timeout=5)
                deleted = subprocess.run([binary, "session", "delete", name, "--json"], env=env,
                                         capture_output=True, text=True, timeout=10)
                result["cleanup"] = {"server_exited": server.poll() is not None,
                                     "session_stopped": stopped.returncode == 0,
                                     "session_deleted": deleted.returncode == 0}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--fixture", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture:
        fixture()
    else:
        findings = json.dumps(probe(), indent=2) + "\n"
        if args.out:
            args.out.write_text(findings)
        print(findings, end="")
