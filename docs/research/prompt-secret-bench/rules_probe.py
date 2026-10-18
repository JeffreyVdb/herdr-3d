"""Disposable research recognizer; deliberately NOT a production sanitizer.

Written against the original pilot. Exact substring spans only, no unescaping or
URL decoding. Ambiguous prose boundaries and placeholder policy are hypotheses.
No network, file creation, application integration, or safety guarantee.
"""
import re

KEY = r"(?:[A-Z][A-Z0-9]*_)*(?:PASSWORD|PASSWD|PASSPHRASE|API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY|CLIENT_SECRET|TOKEN|SECRET|WACHTWOORD)"
CONTEXT = r"(?:password|passphrase|api[ _-]?key|api[ _-]?token|access[ _-]?token|client[ _-]?secret|secret|wachtwoord)"
ASSIGN = re.compile(r"(?<![\w])(?:[\"']?" + KEY + r"[\"']?)[ \t]*[:=][ \t]*", re.I)
PROSE = re.compile(r"\b" + CONTEXT + r"\s+(?:(?:is(?: set to)?|to)\s+)?", re.I)
QUOTED = re.compile(r'''(?P<q>["'`])(?P<v>[^\r\n]*?)(?P=q)''')
BARE = re.compile(r'''[^\s"'`,;<>]+''')
PEM = re.compile(r"-----BEGIN (?P<kind>(?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END (?P=kind)-----")
FENCE = re.compile(r"\b" + CONTEXT + r"[^\n]*\r?\n```[^\r\n]*\r?\n(?P<v>[\s\S]*?)\r?\n```", re.I)
BEARER = re.compile(r"\bAuthorization\s*:\s*Bearer[ \t]+(?P<v>[A-Za-z0-9._~+/=-]+)", re.I)
URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/@:]+:(?P<v>[^\s/@]+)@", re.I)
QUERY = re.compile(r"[?&](?:access_token|api_key|token|client_secret)=(?P<v>[^&#\s\"'`]+)", re.I)


def plausible(value, prose=False):
    if not value or value.startswith(("/", "<", "$")):
        return False
    # These exclusions intentionally have no claim of universal correctness.
    if value.lower() in {"example", "password", "changeme", "your_api_key_here", "none", "null"}:
        return False
    if re.fullmatch(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+", value):
        return False
    if value.startswith(("response.", "process.env.", "os.environ")):
        return False
    return not prose or any(c.isdigit() for c in value) or " " in value


def scan(text, prose=True):
    spans = []
    for pattern in [PEM, FENCE, BEARER, URL, QUERY]:
        for m in pattern.finditer(text):
            span = m.span("v") if "v" in m.groupdict() else m.span()
            if plausible(text[slice(*span)]):
                spans.append(span)
    for pattern, is_prose in [(ASSIGN, False)] + ([(PROSE, True)] if prose else []):
        for m in pattern.finditer(text):
            if pattern is ASSIGN and m.start() and text[m.start()-1] in "?&":
                continue  # Query syntax owns its '&' delimiter.
            q = QUOTED.match(text, m.end())
            if q:
                span = q.span("v")
            else:
                b = BARE.match(text, m.end())
                if not b:
                    continue
                span = b.span()
                # Sentence punctuation is ambiguous; this is an exploratory
                # heuristic, never evidence that these boundaries are safe.
                if text[span[1]-1] == ".":
                    span = (span[0], span[1]-1)
            if plausible(text[slice(*span)], prose=is_prose and q is None):
                spans.append(span)
    # Recognized literals repeat in prose without a second assignment.
    values = {text[a:b] for a, b in spans}
    for value in values:
        spans.extend(m.span() for m in re.finditer(re.escape(value), text))
    # Prefer complete structural units over nested candidates; do not create
    # one large secret by merging adjacent credentials.
    return sorted(set((a, b) for a, b in spans if not any(x <= a and y >= b and (x, y) != (a, b) for x, y in spans)))


def combine(structure, other):
    """Prefer structure on overlap, preserve independent provider/model spans."""
    return sorted(set(map(tuple, structure)) | {tuple(s) for s in other if not any(a < s[1] and b > s[0] for a, b in structure)})
