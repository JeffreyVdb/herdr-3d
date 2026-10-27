#!/usr/bin/env python3
"""Probe manual-command tabs in a fresh isolated Herdr session (no sudo).

Uses the earlier terminal spike's stream transport. The input is a synthetic
marker, never a real credential. No existing session or service is touched.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import uuid

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("terminal_probe", Path(__file__).resolve().parents[1] /
                                             "terminal-experience-spike/herdr-probe.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def identity(pid):
    try:
        # comm can contain spaces or parentheses; fields after its final ')'.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": fields[19], "state": fields[0]}
    except FileNotFoundError:
        return None


def alive(record):
    current = identity(record["pid"])
    return bool(current and current["start"] == record["start"] and current["state"] != "Z")


def fixture():
    case = os.environ.get("H3D_MANUAL_PROBE_CASE", "owner")
    evidence = Path.cwd() / (case + ".json")
    records = {"main": identity(os.getpid())}
    evidence.write_text(json.dumps(records))
    if case == "owner":
        print("OWNER_READY", flush=True)
        while True:
            time.sleep(1)
    previous = termios.tcgetattr(0)
    hidden = previous.copy()
    hidden[3] &= ~termios.ECHO
    termios.tcsetattr(0, termios.TCSANOW, hidden)
    print("SYNTHETIC_PASSWORD_PROMPT", flush=True)
    data = os.read(0, 4096)
    termios.tcsetattr(0, termios.TCSANOW, previous)
    if data != b"h3d-synthetic-input-only\n":
        raise SystemExit("Unexpected synthetic input")
    # A normal child and a daemon-like child that detaches and ignores HUP.
    normal = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    detached = subprocess.Popen([sys.executable, "-c",
        "import signal,time; signal.signal(signal.SIGHUP, signal.SIG_IGN); time.sleep(120)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    records.update(normal=identity(normal.pid), detached=identity(detached.pid), input_received=True)
    evidence.write_text(json.dumps(records))
    print("INPUT_ACCEPTED_AND_CHILDREN_RUNNING", flush=True)
    while True:
        time.sleep(1)


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for probe condition")


def probe():
    binary = shutil.which("herdr")
    if not binary:
        raise SystemExit("herdr must be installed")
    result = {"herdr": subprocess.check_output([binary, "--version"], text=True).strip(),
              "real_credentials_used": False, "scope": "isolated local Herdr CLI, not browser/bridge"}
    with tempfile.TemporaryDirectory(prefix="h3d-manual-probe-") as temp:
        root = Path(temp)
        name = "h3d-manual-probe-" + uuid.uuid4().hex[:8]
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("HERDR_", "CLAUDE", "H3D_MANUAL_PROBE"))}
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

        streams, owned = [], []
        with (root / "server.log").open("w") as log:
            server = subprocess.Popen(prefix + ["server"], env=env, cwd=root,
                                      stdout=log, stderr=log, start_new_session=True)
            try:
                wait_for(lambda: cli("workspace", "list", check=False) is not None)
                created = cli("workspace", "create", "--cwd", str(root), "--no-focus")
                workspace = created["result"]["workspace"]["workspace_id"]
                wait_for(lambda: (root / "owner.json").exists())
                owner = json.loads((root / "owner.json").read_text())["main"]
                owned.append(owner)
                for case in ("tab_close", "workspace_close"):
                    tab = cli("tab", "create", "--workspace", workspace, "--cwd", str(root),
                              "--label", "Manual probe: " + case, "--no-focus", "--env",
                              "H3D_MANUAL_PROBE_CASE=" + case)["result"]
                    pane = tab["root_pane"]["pane_id"]
                    tab_id = tab["tab"]["tab_id"]
                    controller = transport.Stream(prefix + ["terminal", "session", "control", pane,
                                                   "--cols", "100", "--rows", "30"], env, log)
                    streams.append(controller)
                    controller.wait(lambda r: b"SYNTHETIC_PASSWORD_PROMPT" in transport.frame_bytes(r))
                    controller.send(type="terminal.input", text="h3d-synthetic-input-only\n")
                    controller.wait(lambda r: b"INPUT_ACCEPTED_AND_CHILDREN_RUNNING" in
                                    transport.frame_bytes(r))
                    evidence = json.loads((root / (case + ".json")).read_text())
                    processes = {k: evidence[k] for k in ("main", "normal", "detached")}
                    owned.extend(processes.values())
                    frames = b"".join(transport.frame_bytes(r) for r in controller.records)
                    hidden = b"h3d-synthetic-input-only" not in frames
                    argv_hidden = all(b"h3d-synthetic-input-only" not in
                                      Path(f"/proc/{p['pid']}/cmdline").read_bytes()
                                      for p in [*processes.values(), identity(controller.proc.pid)])
                    controller.close()
                    release_survived = all(alive(p) for p in processes.values())
                    # Give the detached child's signal setup time to settle.
                    time.sleep(0.2)
                    cli("tab", "close", tab_id) if case == "tab_close" else cli("workspace", "close", workspace)
                    time.sleep(1)
                    result[case] = {"input_received": evidence["input_received"],
                                    "input_absent_from_frames": hidden,
                                    "input_absent_from_process_argv": argv_hidden,
                                    "controller_release_preserved_processes": release_survived,
                                    "alive_after_close": {k: alive(p) for k, p in processes.items()},
                                    "owner_alive_after_close": alive(owner)}
                    assert hidden and argv_hidden and release_survived
                    assert alive(owner) == (case == "tab_close")
            finally:
                for stream in streams:
                    stream.close()
                # Recover process identities even if an earlier assertion failed.
                for path in root.glob("*.json"):
                    for value in json.loads(path.read_text()).values():
                        if isinstance(value, dict) and "pid" in value:
                            owned.append(value)
                stopped = subprocess.run([binary, "session", "stop", name, "--json"],
                                         env=env, capture_output=True, timeout=10)
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.terminate()
                    server.wait(timeout=5)
                deleted = subprocess.run([binary, "session", "delete", name, "--json"],
                                         env=env, capture_output=True, timeout=10)
                for record in owned:
                    if alive(record):
                        os.kill(record["pid"], signal.SIGKILL)
                wait_for(lambda: not any(alive(p) for p in owned))
                result["cleanup"] = {"server_exited": server.poll() is not None,
                                     "session_stopped": stopped.returncode == 0,
                                     "session_deleted": deleted.returncode == 0,
                                     "all_probe_processes_stopped": True}
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
