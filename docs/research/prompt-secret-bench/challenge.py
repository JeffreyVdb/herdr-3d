"""Fresh synthetic challenge, authored AFTER freezing rules_probe.py.

Same investigator, not an independent/representative production holdout. Families
have repeated randomized instances; report family counts as well as occurrences.
Expected spans are original source substrings, never decoded or normalized.
"""
import base64
import hashlib
import json
from pathlib import Path
import random
import re
import string

HERE = Path(__file__).resolve().parent


def main():
    rng = random.Random(10820261018)
    cases = []
    def tok(n=31):
        return "".join(rng.choice(string.ascii_letters+string.digits) for _ in range(n))
    def add(family, template, *values, group=None):
        # Label inserted slots, not every incidental identical word in prose.
        text, spans, previous = "", [], 0
        for match in re.finditer(r"\{([0-9]+)\}", template):
            text += template[previous:match.start()]
            value = values[int(match[1])]
            spans.append([len(text), len(text)+len(value)])
            text += value
            previous = match.end()
        text += template[previous:]
        assert all(a<b for a,b in spans)
        cases.append(dict(id=f"{family}-{sum(c['family']==family for c in cases)+1}",family=family,
                          group=group or ("challenge" if values else "negative"),text=text,expected=spans))
    families = [
        ("env-quoted", 'SERVICE_PASSWORD="{0}"\nRun the importer.', lambda:tok(13)+"!"),
        ("env-unquoted", 'export SERVICE_API_TOKEN={0}\nRun the importer.', lambda:tok()),
        ("json", 'Deploy with {"password":"{0}","pool":4}', lambda:tok(11)+"#"),
        ("yaml", 'credentials:\n  password: "{0}"\n  host: db.internal.test', lambda:tok(9)+"!"),
        ("prose", 'The deployment password is {0}. Authenticate.', lambda:tok(14)+"!"),
        ("quoted-prose", 'Use password "{0}" for the staging login.', lambda:"quiet birch "+tok(6)),
        ("backticks", 'Change the password to `{0}` before proceeding.', lambda:"@"+tok(11)+"#$%"),
        ("bearer", 'Authorization: Bearer {0}\nGet the status.', lambda:tok(37)),
        ("url", 'Use mysql://reader:{0}@database.example.test:3306/db', lambda:tok(7)+"%40"+tok(7)),
        ("query", 'GET https://svc.example.test?api_key={0}&page=2', lambda:tok()),
        ("fenced", 'Access token (two lines):\n```text\n{0}\n```\nKeep both lines.', lambda:tok(19)+"\n"+tok(19)),
        ("unicode", 'The password is "{0}". Use it.', lambda:"é🌻"+tok(7)+"!?"),
        ("dutch", 'Het wachtwoord is {0}. Maak verbinding.', lambda:tok(10)+"!"),
        ("github-valid", 'Authenticate using {0} on GitHub.', lambda:"ghp_"+tok(36)),
        ("hf-valid", 'Download with {0}.', lambda:"hf_"+"".join(rng.choice(string.ascii_letters) for _ in range(34))),
        ("bare", 'Use {0}', lambda:tok()),
        ("french", 'Le mot de passe est «{0}». Connecte-toi.', lambda:tok(10)+"!"),
        ("spanish", 'La contraseña es {0}. Conéctate.', lambda:tok(10)+"!"),
    ]
    for family, template, value in families:
        for _ in range(3):
            add(family,template,value())
    for _ in range(3):
        a,b=tok(12)+"!",tok(29)
        add("two-values", 'Use password="{0}" and api_key="{1}".',a,b)
        add("repeat", 'Service password is "{0}". Retry with {0}.',tok(12)+"!")
    # Boundary and policy cases; none cause a post-challenge rule adjustment.
    special = [
        ("trailing-dot", 'PASSWORD={0}', "Literal9!."),
        ("sentence-dot", 'The password is {0}.', "Literal9!."),
        ("space-unquoted", 'The password is {0}. Connect now.', "birch river meadow"),
        ("escaped-quote", 'Use {"password":"{0}"}.', 'Road\\"Map9!'),
        ("json-escaped-newline", 'Use {"password":"{0}"}.', 'Road9!\\nMap8#'),
        ("weak-real", 'The actual password is "{0}". Authenticate.', "example"),
        ("weak-real", 'The actual password is "{0}". Authenticate.', "password"),
        ("digits-real", 'PASSWORD={0}', "123456"),
        ("uppercase-real", 'PASSWORD={0}', "NOT_A_PLACEHOLDER"),
        ("dollar-real", 'PASSWORD="{0}"', "$Actual9!"),
        ("leading-space", 'PASSWORD="{0}"', "  Actual9! "),
        ("crlf", 'Access token:\r\n```\r\n{0}\r\n```', tok(17)+"\r\n"+tok(17)),
        ("yaml-block", 'password: |\n{0}\nhost: db.example.test', "  " + tok(10)+"\n  "+tok(10)),
        ("basic", 'Authorization: Basic {0}',base64.b64encode(b"synthetic:NeverIssued9!").decode()),
        ("recovery", 'The one-time recovery code is {0}.', "1792-4638-5021"),
    ]
    for family,template,value in special:
        add(family,template,value)
    for width in [0,1,2]:
        body = "module notes "*(230+width*19)
        add("long-boundary",body+'\nThe password is "{0}".\n'+body,tok(13)+"!",group="long")
    clean = [
        'The password is correct. Explain the authentication flow.',
        'The password is at least 12 characters long.',
        'The API key is rotated every 30 days.',
        'The password is stored in a 0600 file.',
        'Set password="<REDACTED>" in the example.',
        'password: ${DATABASE_PASSWORD}',
        'password: "${DATABASE_PASSWORD}"',
        'password: "{{ vault.database_password }}"',
        'password: "[REDACTED]"',
        'password: "********"',
        'password: "REPLACE_ME"',
        'password: "your-password-here"',
        'password: "changeme" # documentation placeholder',
        'The example API key is "YOUR_API_KEY".',
        'api_key="example-token-do-not-use" in the docs.',
        'api_key: process.env.SERVICE_API_KEY',
        'api_key: os.environ["SERVICE_API_KEY"]',
        'PASSWORD_FILE=/run/user/1000/credential-file',
        'The password is in /run/user/1000/credential-file.',
        'Use https://service.example.test?access_token=YOUR_TOKEN',
        'The access token is response.access_token.',
        'The secret is 42 lines long, according to the old documentation.',
        'The password is a 16-character random string.',
        'The API key is not provided. Ask the operator.',
        'password = getPassword()',
        'const client_secret = settings.clientSecret;',
        'Do not rename client_secret or api_key in the schema.',
        'Use the public SSH key from the authorized_keys file.',
        'Authorization: Bearer ${ACCESS_TOKEN}',
        'Use postgres://user:password@localhost only as a documentation template.',
    ]
    for i,text in enumerate(clean):
        for variant in range(2):
            add(f"clean-{i+1:02}",text+f"\nContext request {tok(9)}; build {variant+1}.")
    output=HERE/"followup/challenge-corpus.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(cases,indent=2,ensure_ascii=False)+"\n")
    manifest=dict(seed=10820261018,source_substring_values=True,rules_frozen_sha256=hashlib.sha256((HERE/'rules_probe.py').read_bytes()).hexdigest(),
                  corpus_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),prompts=len(cases),
                  secret_occurrences=sum(len(c['expected']) for c in cases),negative_prompts=sum(not c['expected'] for c in cases),
                  positive_families=len({c['family'] for c in cases if c['expected']}),negative_families=len(clean),
                  limitation="Same author; repeated template families; not an independently authored or representative production holdout. Rules frozen before challenge authoring; no post-challenge tuning.")
    (output.parent/'challenge-manifest.json').write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps(manifest,indent=2))


if __name__ == '__main__':
    main()
