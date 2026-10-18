"""Synthetic prompt-secret extraction pilot. No real credentials or network verification.

Run with a CPU-only environment; see README.md. All offsets are Python character
offsets. Accuracy is exact-span extraction, not document classification.
"""
import argparse
import base64
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import re
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
LABELS = ["password", "api key", "access token", "private key", "client secret"]


def corpus():
    rng = random.Random(1831)
    def token(n, alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"):
        return "".join(rng.choice(alphabet) for _ in range(n))
    cases = []
    def add(name, group, template, *values):
        text = template
        for i, value in enumerate(values):
            text = text.replace("{" + str(i) + "}", value)
        spans = []
        for value in dict.fromkeys(values):
            spans.extend([m.start(), m.end()] for m in re.finditer(re.escape(value), text))
        cases.append(dict(id=name, group=group, text=text, expected=sorted(spans)))
    add("github-assignment", "provider", 'GITHUB_TOKEN="{0}"\nUse it to query the repository.', "ghp_" + token(36))
    add("github-prose", "provider", 'Use {0} to access my GitHub account.', "ghp_" + token(36))
    add("github-fine", "provider", 'My GitHub token is {0}.', "github_pat_" + token(22) + "_" + token(59))
    add("aws-pair", "provider", 'AWS_ACCESS_KEY_ID={0}\nAWS_SECRET_ACCESS_KEY={1}\nList my buckets.', "AKIA" + token(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), token(40))
    add("openai", "provider", 'OPENAI_API_KEY={0}\nUse this key.', "sk-proj-" + token(120))
    add("stripe", "provider", 'Use STRIPE_SECRET_KEY={0} for the billing API.', "sk_live_" + token(24))
    add("slack", "provider", 'Use my bot token {0} to read the channel.', "xoxb-" + token(12, "0123456789") + "-" + token(12, "0123456789") + "-" + token(24))
    add("gitlab", "provider", 'GitLab access token: {0}', "glpat-" + token(20))
    add("npm", "provider", 'Publish with NPM_TOKEN={0}', "npm_" + token(36))
    add("hf", "provider", 'HF_TOKEN={0}\nDownload the weights.', "hf_" + token(34))
    add("generic-prose", "context", 'Use the secret {0} to authenticate with our internal service.', token(36))
    add("generic-assignment", "context", 'INTERNAL_API_KEY="{0}"\nCall the internal API.', token(40))
    add("bearer", "context", 'curl -H "Authorization: Bearer {0}" https://service.example.test/status', token(42))
    add("password-prose", "context", 'The database password is {0}. Please connect.', "Moonlight7!")
    add("passphrase", "context", 'The password is "{0}". Use it to log in.', "lilac otter river cinnamon")
    add("short-password", "context", 'Login password: {0}', "fawn7")
    add("punctuation", "context", 'Set the password to `{0}` and test the login.', "a!B@c#D$e%F^g&H*i(J)k=L+M")
    add("json", "context", 'Use this configuration: {"client_secret":"{0}","region":"eu"}', token(32))
    add("env", "context", 'Use this .env:\n```env\nDB_PASSWORD={0}\nAPI_TOKEN={1}\n```', "Tidepool8!", token(32))
    add("url", "context", 'Connect to postgres://app:{0}@db.example.test:5432/app', "Crane7%21Willow")
    add("query-token", "context", 'Call https://api.example.test/v1?access_token={0}&limit=10', token(32))
    jwt = ".".join(base64.urlsafe_b64encode(x).decode().rstrip("=") for x in [b'{"alg":"HS256","typ":"JWT"}', b'{"sub":"synthetic","scope":"read"}', b'synthetic-signature-never-valid'])
    add("jwt", "context", 'Authorization: Bearer {0}', jwt)
    pem = "-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(bytes(rng.randrange(256) for _ in range(240))).decode() + "\n-----END PRIVATE KEY-----"
    add("pem", "multiline", 'Use this private key:\n{0}\nConnect to the server.', pem)
    add("multiline-token", "multiline", 'API token (preserve the newline):\n```\n{0}\n```', token(28) + "\n" + token(28))
    value = token(32)
    add("repeat", "context", 'API key is {0}. If the request fails, retry with {0}.', value)
    add("two-secrets", "context", 'The password is {0} and the API key is {1}.', "Willow6!", token(36))
    add("unicode-context", "context", '🔒 Mijn wachtwoord is {0}. Gebruik dit voor de database.', "Lente9!Fiets")
    add("unicode-secret", "context", 'My password is "{0}". Log in.', "wólk🌧️Zeven9!")
    add("bare-token", "unlabeled", 'Use {0}', token(40))
    add("bare-password", "unlabeled", 'Use {0}', "Saffron8!")
    add("long-8k", "long", ("Review the module and keep its behavior. " * 210) + '\nThe password is {0}.', "LongTail8!Secret")
    add("long-16k", "long", ("Review the module and keep its behavior. " * 415) + '\nAPI_KEY={0}', token(40))
    negatives = [
        "Explain how API tokens should be stored.",
        "Read the secret from /run/user/1000/herdr/secrets/credential-1.",
        "Use the existing GITHUB_TOKEN environment variable.",
        'The example says API_KEY="YOUR_API_KEY_HERE". Explain it.',
        'Set password="<password>" in the documentation example.',
        'This is an intentionally fake placeholder: api_key="example".',
        "The SHA-256 checksum is " + token(64, "0123456789abcdef"),
        "Check commit " + token(40, "0123456789abcdef") + " for the regression.",
        "The request ID is 0f69d9e1-a62a-4d80-b0f0-0de83bcf4139.",
        "Look at src/auth/token.ts and update parseToken().",
        "Please email Alex at alex@example.test.",
        "Connect to db.example.test on port 5432 as user app.",
        "Here is a public SSH key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + token(43),
        "Use AWS_ACCESS_KEY_ID from the credentials file; don't print it.",
        'const token = response.access_token; return token;',
        'assert(password.length >= 12); // ensure a strong password',
        "The variable name client_secret must remain unchanged.",
        "Use /tmp/secret.txt and delete it afterward.",
        "The ticket number is 1831 and the release version is 8.30.1.",
        "My user ID is 897123 and the feature flag is on.",
        "Do not expose secrets. Use the secure file we already created.",
        "The build artifact is named " + token(36) + ".tar.gz.",
    ]
    for i, text in enumerate(negatives):
        add(f"negative-{i+1:02}", "negative", text)
    return cases


def merge(spans):
    out = []
    for start, end in sorted(set(map(tuple, spans))):
        if out and start < out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out


def evaluate(cases, predictions):
    tp = fp = fn = covered = total = negfp = neg = partial = 0
    groups = {}
    for case in cases:
        expected = list(map(tuple, case["expected"]))
        got = list(map(tuple, merge(predictions[case["id"]])))
        matches = len(set(expected) & set(got))
        tp += matches
        fp += len(got) - matches
        fn += len(expected) - matches
        total += len(expected)
        full = sum(any(a <= s and b >= e for a, b in got) for s, e in expected)
        covered += full
        partial += sum(any(a < e and b > s for a, b in got) and not any(a <= s and b >= e for a, b in got) for s, e in expected)
        neg += not bool(expected)
        negfp += not bool(expected) and bool(got)
        g = groups.setdefault(case["group"], dict(secrets=0, exact=0, covered=0))
        g["secrets"] += len(expected)
        g["exact"] += matches
        g["covered"] += full
    return dict(exact_tp=tp, exact_fp=fp, exact_fn=fn, exact_precision=tp/(tp+fp) if tp+fp else 0,
                exact_recall=tp/total, fully_covered=covered, secrets=total,
                partial_only=partial, negative_prompts_flagged=negfp, negative_prompts=neg, groups=groups)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--detector", choices=["gitleaks", "gitleaks-service", "detect-secrets", "gliner", "gliner2"], required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--chunked", action="store_true", help="GLiNER2 long API for inputs over 4,096 characters")
    parser.add_argument("--model", default="knowledgator/gliner-pii-small-v1.0")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--gitleaks", default="/tmp/herdr-secret-tools/gitleaks")
    args = parser.parse_args()
    assert args.repeats >= 1
    cases = corpus()
    (HERE / "corpus.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n")
    start = time.perf_counter()
    meta = dict(python=platform.python_version(), platform=platform.platform(), threads=4,
                repeats=args.repeats, corpus_sha256=hashlib.sha256((HERE / "corpus.json").read_bytes()).hexdigest())
    service = None
    if args.detector in ["gliner", "gliner2"]:
        import torch
        torch.set_num_threads(4)
        if args.detector == "gliner":
            from gliner import GLiNER
            model = GLiNER.from_pretrained(args.model, revision=args.revision, local_files_only=True).eval()
            labels = LABELS
        else:
            from gliner2 import GLiNER2
            model = GLiNER2.from_pretrained(args.model, revision=args.revision, local_files_only=True).eval()
            labels = ["password", "secret", "api_key", "access_token", "recovery_code"]
        meta.update(model=args.model, revision=args.revision, labels=labels,
                    versions={k: importlib.metadata.version(k) for k in ["gliner", "torch", "transformers", "huggingface-hub"]})
        if args.detector == "gliner2":
            meta["versions"]["gliner2"] = importlib.metadata.version("gliner2")
            meta["chunked"] = args.chunked
        def scan(text):
            with torch.inference_mode():
                if args.detector == "gliner":
                    return model.predict_entities(text, labels, threshold=0.3)
                extract = model.extract_entities_long if args.chunked and len(text) > 4096 else model.extract_entities
                result = extract(text, labels, threshold=0.3, include_confidence=True, include_spans=True)
                return [dict(start=e["start"], end=e["end"], score=e["confidence"], label=label) for label, entities in result["entities"].items() for e in entities]
        thresholds = [0.3, 0.5, 0.7]
    elif args.detector == "detect-secrets":
        from detect_secrets.core.scan import scan_line
        from detect_secrets.settings import default_settings
        settings = default_settings()
        settings.__enter__()
        # Never verify candidate values with provider APIs.
        from detect_secrets.settings import get_settings, get_plugins
        from detect_secrets.plugins.high_entropy_strings import HighEntropyStringsPlugin
        get_settings().disable_filters('detect_secrets.filters.common.is_ignored_due_to_verification_policies')
        import requests
        def no_network(*a, **kw):
            raise RuntimeError("Network disabled for synthetic secret detection")
        requests.sessions.Session.request = no_network
        meta["version"] = importlib.metadata.version("detect-secrets")
        meta["adapter"] = "scan_line; enforce configured entropy thresholds on eager entropy results; no verification"
        entropy_plugins = {p.secret_type: p for p in get_plugins() if isinstance(p, HighEntropyStringsPlugin)}
        def scan(text):
            entities, offset = [], 0
            for line in text.splitlines(keepends=True):
                for found in scan_line(line):
                    value = found.secret_value
                    if value:
                        # scan_line intentionally returns below-threshold entropy candidates
                        # for CLI diagnostic display. They are not positive detections.
                        p = entropy_plugins.get(found.type)
                        if p and p.calculate_shannon_entropy(value) <= p.entropy_limit:
                            continue
                        entities.extend(dict(start=offset+m.start(), end=offset+m.end(), score=1, label=found.type) for m in re.finditer(re.escape(value), line))
                offset += len(line)
            return entities
        thresholds = [0.5]
    elif args.detector == "gitleaks-service":
        meta.update(version="8.30.1", adapter="persistent Go DetectString; default configuration; no network verification")
        service = subprocess.Popen([args.gitleaks], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        def scan(text):
            service.stdin.write(json.dumps(dict(text=text)) + "\n")
            service.stdin.flush()
            found = json.loads(service.stdout.readline())
            meta["rules_load_ms"] = found["load_ms"]
            return [dict(start=m.start(), end=m.end(), score=1, label=f["RuleID"]) for f in (found["findings"] or []) for m in re.finditer(re.escape(f["Secret"]), text)]
        thresholds = [0.5]
    else:
        import tempfile
        meta["version"] = subprocess.check_output([args.gitleaks, "version"], text=True).strip()
        def scan(text):
            # One invocation per prompt; this includes process launch cost.
            with tempfile.TemporaryDirectory(prefix="secret-bench-") as tmp:
                report = Path(tmp) / "report.json"
                run = subprocess.run([args.gitleaks, "stdin", "--no-banner", "--exit-code=0", "--report-format=json", "--report-path="+str(report)], input=text, text=True, capture_output=True)
                if run.returncode:
                    raise RuntimeError(run.stderr)
                entities = []
                for found in json.loads(report.read_text()):
                    entities.extend(dict(start=m.start(), end=m.end(), score=1, label=found["RuleID"]) for m in re.finditer(re.escape(found["Secret"]), text))
                return entities
        thresholds = [0.5]
    load_seconds = time.perf_counter() - start
    scan("The password is Pilot9!Sparrow.")  # warmup; excluded from timings
    raw, timings = {}, {}
    for case in cases:
        elapsed = []
        for _ in range(args.repeats):
            start = time.perf_counter()
            entities = scan(case["text"])
            elapsed.append(1000 * (time.perf_counter() - start))
        raw[case["id"]] = entities
        timings[case["id"]] = elapsed
    if service is not None:
        service.stdin.close()
        assert service.wait(timeout=5) == 0
    import resource
    output = dict(detector=args.detector, meta=meta, load_seconds=load_seconds,
                  peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                  child_peak_rss_mib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss/1024,
                  timings_ms=timings, raw=raw, results={})
    for threshold in thresholds:
        predictions = {k: merge([[e["start"], e["end"]] for e in v if e["score"] >= threshold]) for k, v in raw.items()}
        output["results"][str(threshold)] = dict(metrics=evaluate(cases, predictions), predictions=predictions)
    short = [v for c in cases if c["group"] != "long" for v in timings[c["id"]]]
    output["short_latency_ms"] = dict(p50=statistics.median(short), p95=sorted(short)[int(len(short)*0.95)])
    name = args.model.split("/")[-1] if args.detector in ["gliner", "gliner2"] else args.detector
    if args.chunked:
        name += "-chunked"
    (HERE / (name + ".json")).write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: output[k] for k in ["detector", "load_seconds", "peak_rss_mib", "short_latency_ms"]}))
    for t, result in output["results"].items():
        print(t, json.dumps(result["metrics"]))


if __name__ == "__main__":
    main()
