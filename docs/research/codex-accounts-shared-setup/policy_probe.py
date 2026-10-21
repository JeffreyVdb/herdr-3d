"""Issue #137: read-only app-server probe of one CODEX_HOME.

Usage: python3 policy_probe.py <codex-home> [cwd [codex app-server args...]]

Extra arguments (for example `-c mcp_servers.x.url="https://…"`) go to
`codex app-server` as CLI overrides; nothing is written to the home.

Starts `codex app-server` on stdio with CODEX_HOME=<codex-home>, sends only
read requests (no thread, no turn, no config write, no login) and prints one
sanitized JSON document. Every string value is replaced by "<str>" unless its
key is on an allow list of non-identifying names, so e-mails, account ids,
tokens, hashes, paths and the organisation's policy text cannot reach stdout.
Side effect: starting the server may refresh the home's token and refill its
caches, as in #136.
"""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ALLOW_KEYS = {
    "slug", "type", "status", "authStatus", "planType", "scope", "kind",
    "enabled", "approvalPolicy", "sandbox", "version", "source",
    "trustStatus", "eventName", "isManaged",
}
# lists whose string members are policy enums, not identities
ENUM_LISTS = {
    "allowedApprovalPolicies", "allowedSandboxModes", "allowedWebSearchModes",
    "allowedLoginMethods", "allowedApprovalsReviewers",
}
# `name` is a catalog name (skill, MCP server, plugin, connector, hook event)
NAME_METHODS = {
    "skills/list", "mcpServerStatus/list", "plugin/list", "plugin/installed",
    "app/list", "hooks/list", "model/list",
}
LENGTH_ONLY = {"additionalDeveloperInstructions"}


def clean(v, method, key=None):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in LENGTH_ONLY:
                out[k] = None if x is None else {"present": True, "chars": len(str(x))}
            elif k in ("email", "chatgptAccountId", "backendOrigin"):
                out[k] = "<redacted>"
            else:
                out[k] = clean(x, method, k)
        return out
    if isinstance(v, list):
        if key in ENUM_LISTS:
            return v
        return [clean(x, method, key) for x in v]
    if isinstance(v, str):
        if key in ALLOW_KEYS or (key == "name" and method in NAME_METHODS):
            return v
        return "<str>"
    return v


def summarize(method, res):
    """Catalog calls return whole directories; keep names and counts only."""
    if method == "app/list":
        apps = res.get("data", [])
        return {
            "total": len(apps),
            "has_next_page": bool(res.get("nextCursor")),
            "accessible": sorted(a["name"] for a in apps if a.get("isAccessible")),
        }
    if method == "mcpServerStatus/list":
        return [
            {"name": s.get("name"), "authStatus": s.get("authStatus"), "tools": len(s.get("tools") or {})}
            for s in res.get("data", [])
        ]
    if method == "skills/list":
        return {
            c.get("cwd") and "cwd": {
                "scopes": sorted({s.get("scope") for s in c.get("skills", [])}),
                "names": sorted(s["name"] for s in c.get("skills", [])),
                "errors": len(c.get("errors", [])),
            }
            for c in res.get("data", [])
        }
    if method == "hooks/list":
        return [
            {"hooks": clean(c.get("hooks", []), method), "errors": len(c.get("errors", [])), "warnings": len(c.get("warnings", []))}
            for c in res.get("data", [])
        ]
    if method == "plugin/installed":
        return [
            {"plugins": [{"name": p.get("name"), "installed": p.get("installed"), "enabled": p.get("enabled")} for p in m.get("plugins", [])]}
            for m in res.get("marketplaces", [])
        ]
    if method == "model/list":
        return sorted(m["id"] if "id" in m else m.get("model", "?") for m in res.get("data", []))
    if method == "config/read":
        cfg = res.get("config", {})
        return {
            "layers": [l.get("name", {}).get("type") for l in res.get("layers", [])],
            "mcp_servers": sorted((cfg.get("mcp_servers") or {}).keys()),
            "approval_policy": cfg.get("approval_policy"),
            "sandbox_mode": cfg.get("sandbox_mode"),
            "features.hooks": (cfg.get("features") or {}).get("hooks"),
            "projects_trusted": len(cfg.get("projects") or {}),
            "hook_trust_entries": len((cfg.get("hooks") or {}).get("state") or {}),
            "developer_instructions_set": cfg.get("developer_instructions") is not None,
        }
    return clean(res, method)


def main():
    home = Path(sys.argv[1]).expanduser()
    cwd = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    env = dict(os.environ, CODEX_HOME=str(home))
    p = subprocess.Popen(
        ["codex", "app-server", *sys.argv[3:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env=env, text=True, cwd=cwd,
    )
    pending, lock, warnings = {}, threading.Condition(), []

    def reader():
        for line in p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            with lock:
                if "id" in m and ("result" in m or "error" in m):
                    pending[m["id"]] = m
                elif m.get("method") == "configWarning":
                    warnings.append(m.get("params", {}))
                lock.notify_all()

    threading.Thread(target=reader, daemon=True).start()
    n = [0]

    def call(method, params=None, timeout=60):
        n[0] += 1
        i = n[0]
        msg = {"id": i, "method": method}
        if params is not None:
            msg["params"] = params
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        with lock:
            while i not in pending:
                if time.time() > end:
                    return {"error": "timeout"}
                lock.wait(1)
            return pending.pop(i)

    init = call("initialize", {
        "clientInfo": {"name": "h3d-137-probe", "title": "h3d-137", "version": "0"},
        "capabilities": {"experimentalApi": True},
    })
    p.stdin.write(json.dumps({"method": "initialized"}) + "\n")
    p.stdin.flush()
    report = {"initialize_ok": "result" in init}
    probes = [
        ("account/read", {"refreshToken": False}),
        ("configRequirements/read", None),
        ("config/read", {"cwd": cwd, "includeLayers": True}),
        ("hooks/list", {"cwds": [cwd]}),
        ("skills/list", {"cwds": [cwd], "forceReload": True}),
        ("mcpServerStatus/list", {"detail": "toolsAndAuthOnly"}),
        ("plugin/installed", {"cwds": [cwd]}),
        ("model/list", {"includeHidden": True}),
        ("app/list", {}),
    ]
    for method, params in probes:
        r = call(method, params)
        if "result" in r:
            report[method] = summarize(method, r["result"])
        else:
            e = r.get("error")
            report[method] = {"error": clean(e, method) if isinstance(e, dict) else e}
    time.sleep(1)
    report["configWarnings"] = len(warnings)
    p.stdin.close()
    p.terminate()
    print(json.dumps(report, indent=1, sort_keys=True))


main()
