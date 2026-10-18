#!/usr/bin/env python3
"""Independent phase-1 holdout. Python stdlib only; run python3 -I generate.py."""
import base64
from collections import Counter
import hashlib
import hmac
import json
from pathlib import Path
import random
import re
import string
import shlex
import urllib.parse

ROOT = Path(__file__).resolve().parent
SEED = 10820261018
DATE = '2026-10-18'
rng = random.Random(SEED)
rows = []
ALNUM = string.ascii_letters + string.digits

def rand(n=24, alphabet=ALNUM):
    return ''.join(rng.choice(alphabet) for _ in range(n))

def secret(raw, syntax='plain', kind='password', decoded=None):
    return {'raw': raw, 'decoded': raw if decoded is None else decoded, 'syntax': syntax, 'kind': kind}

def add(category, family, *parts, **extra):
    text = ''
    spans = []
    for part in parts:
        if isinstance(part, str):
            text += part
        else:
            start = len(text.encode('utf-8'))
            start_u16 = len(text.encode('utf-16-le')) // 2
            text += part['raw']
            spans.append(dict(part, start=start, end=len(text.encode('utf-8')),
                              start_u16=start_u16, end_u16=len(text.encode('utf-16-le')) // 2))
    rows.append(dict(id=f'heldout-{len(rows)+1:05d}', family=family, category=category,
                     split='positive' if spans else 'clean', text=text, secrets=spans, **extra))

# Lexical conformance means public scanner grammar, never a live provider credential.
PROVIDERS = {
    'aws': (lambda: 'AKIA'+rand(16, string.ascii_uppercase+'234567'), r'AKIA[A-Z2-7]{16}'),
    'github-pat': (lambda: 'ghp_'+rand(36), r'ghp_[0-9A-Za-z]{36}'),
    'openai': (lambda: 'sk-'+rand(20)+'T3BlbkFJ'+rand(20), r'sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}'),
    'github-fine': (lambda: 'github_pat_'+rand(22)+'_'+rand(59), r'github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}'),
    'openai-project': (lambda: 'sk-proj-'+rand(74)+'T3BlbkFJ'+rand(74), r'sk-proj-[A-Za-z0-9]{74}T3BlbkFJ[A-Za-z0-9]{74}'),
    'hf': (lambda: 'hf_'+rand(34, string.ascii_letters), r'hf_[A-Za-z]{34}'),
    'slack': (lambda: 'xoxb-'+rand(12,string.digits)+'-'+rand(12,string.digits)+'-'+rand(24), r'xoxb-[0-9]{12}-[0-9]{12}-[A-Za-z0-9]{24}'),
    'stripe': (lambda: 'sk_live_'+rand(24), r'sk_live_[A-Za-z0-9]{24}'),
}
for kind, (make, grammar) in PROVIDERS.items():
    for malformed in (False, True):
        for j in range(12):
            value = make()
            assert re.fullmatch(grammar, value)
            if malformed:
                # Invalidate required alphabet while keeping the prefix and credential intent.
                value = value[:8]+'!'+value[9:]
                assert not re.fullmatch(grammar, value)
            cat = 'provider-malformed' if malformed else 'provider-valid'
            s = secret(value, kind={'github-fine':'github-pat','openai-project':'openai'}.get(kind,kind))
            family = ['provider-handoff','provider-config-review','provider-failing-request'][j % 3]
            if j % 3 == 0:
                add(cat,family, f'Wire the {kind} integration to the staging tenant. The actual API credential is ',s,'\nUse it for the acceptance check.', provider_format='malformed' if malformed else 'grammar-valid', provider_generation=kind)
            elif j % 3 == 1:
                s['syntax']='env-assignment'
                add(cat,family, f'Review this local integration config for {kind}:\nAPI_TOKEN=',s,'\nRETRY_COUNT=3\n', provider_format='malformed' if malformed else 'grammar-valid', provider_generation=kind)
            else:
                s['syntax']='header'
                add(cat,family, f'Debug the {kind} adapter request:\nGET /status HTTP/1.1\nAuthorization: Bearer ',s,'\nAccept: application/json\n', provider_format='malformed' if malformed else 'grammar-valid', provider_generation=kind)

# Each trailing delimiter is outside the annotated token; separate meaningful punctuation cases below.
for delim in ['.', ',', ')', ';', ':', '"', "'"]:
    for j in range(6):
        value = PROVIDERS['hf'][0]()
        s = secret(value, kind='hf')
        family = ['punctuation-prose','punctuation-review','punctuation-readme'][j%3]
        prefix = ['Use this Hugging Face credential: ', 'Review comment: retry with token (', 'README deployment note\nAPI token: '][j%3]
        add('trailing-punctuation',family,prefix,s,delim+'\nThen verify the returned model list.', delimiter=delim)

for value in ['example','password123','changeme']:
    for j in range(9):
        family=['weak-password-login','weak-password-config','weak-password-incident'][j%3]
        if j%3==0:
            add('weak-password',family,'Log into the seeded staging account; its current password is "',secret(value,'prose'),'". Rotate it after reproducing the error.')
        elif j%3==1:
            add('weak-password',family,'This is the actual dev database credential, not a documentation placeholder:\nDB_PASSWORD=',secret(value,'env-assignment'),'\nPlease test the migration.')
        else:
            add('weak-password',family,'Incident handoff: the temporary operator password was set to `',secret(value,'prose'),'`. Use that exact value to reproduce ticket '+str(j)+'.')

for j in range(12):
    value = 'orbit-'+rand(10)+'"'+'\\'+'line\n終🔐'
    raw = json.dumps(value, ensure_ascii=(j%2==0))[1:-1]
    add('json-escapes', ['json-pasted-config','json-review','json-stack-context'][j%3],
        ['Repair the loader for this config:\n','Review the credential parsing change against this payload:\n','The stack trace points at load_credentials; here is the input:\n'][j%3],
        '{"password":"',secret(raw,'json-string',decoded=value),'","retry":2}\n')
for j in range(12):
    value = 'moon-'+rand(10)+'"$HOME`id`\\end'
    raw = value.replace('\\','\\\\').replace('"','\\"').replace('$','\\$').replace('`','\\`')
    add('shell-escapes',['shell-curl-double','shell-export-double','shell-command-review'][j%3],
        ['Fix this curl command:\ncurl -u "builder:', 'Why does this deployment fail?\nexport PASSWORD="','Review this shell fragment:\nPASSWORD="'][j%3],
        secret(raw,'shell-double',decoded=value),'"\n')
for j in range(12):
    value = 'starlit-'+rand(12)+"'east"
    raw = value.replace("'", "'\\''")
    add('shell-escapes',['shell-single-export','shell-single-cli','shell-single-handoff'][j%3],
        ['Reproduce my shell setup:\nPASSWORD=\'', 'Run the test with --password \'', 'The working deployment snippet is:\nexport DB_PASSWORD=\''][j%3],
        secret(raw,'shell-single',decoded=value),"'\n")

for j in range(18):
    value = 'été🔑:'+rand(9)+'@/+%'
    encoded = urllib.parse.quote(value, safe='')
    if j%3==0:
        add('url-encoding','url-userinfo-password','Investigate this connection URL; the username is public:\npostgresql://app:',secret(encoded,'url-userinfo',decoded=value),'@db.invalid:5432/store?sslmode=require')
    elif j%3==1:
        add('url-encoding','url-query-credential','The callback fails with this URL:\nhttps://api.invalid/start?access_token=',secret(encoded,'url-query','generic-token',value),'&mode=debug')
    else:
        dsn = 'postgresql://app:'+encoded+'@db.invalid:5432/store'
        add('url-encoding','url-entire-dsn','Store this complete connection-string credential from config:\nDATABASE_URL="',secret(dsn,'env-assignment','db-url'),'"\n')

for j in range(12):
    value = 'clé-'+rand(7)+'🔐e\u0301.終'
    family=['unicode-config','unicode-chat','unicode-toml'][j%3]
    if j%3==0:
        add('unicode',family,'🧭 Configure l’accès suivant:\nPASSWORD="',secret(value,'env-assignment'),'"\n')
    elif j%3==1:
        add('unicode',family,'修正してください 🔧 The literal password, including its punctuation, is «',secret(value,'prose'),'». Merci.')
    else:
        add('unicode',family,'Review the TOML parser with this UTF-8 fixture:\n[database]\npassword = "',secret(value,'toml'),'"\n')
for j in range(12):
    value = rand(12)+'!.:'
    family=['crlf-env','crlf-header','crlf-stack'][j%3]
    if j%3==1:
        add('crlf',family,'Inspect the captured Windows request:\r\nAuthorization: Bearer ',secret(value,'header','generic-token'),'\r\nX-Retry: 0\r\n')
    else:
        add('crlf',family,'Investigate the Windows service startup:\r\nDB_PASSWORD="',secret(value,'env-assignment'),'"\r\nTraceback: connect_db failed\r\n')

for j in range(12):
    if j%3==0:
        # RFC 8410 Ed25519 PKCS8: valid DER envelope, synthetic random private seed.
        der = bytes.fromhex('302e020100300506032b657004220420') + bytes(rng.randrange(256) for _ in range(32))
        b64 = base64.b64encode(der).decode()
        value='-----BEGIN PRIVATE KEY-----\n'+b64+'\n-----END PRIVATE KEY-----'
        add('multiline','pem-credential','Fix the key loader; this is the test signing key:\n',secret(value,'pem','private-key'),'\nThe loader must accept the exact block.')
    elif j%3==1:
        a,b=rand(10),rand(10)
        raw='  '+a+'\n  '+b+'\n'
        add('multiline','yaml-literal-clip','Inspect this YAML credential config:\npassword: |\n',secret(raw,'yaml',decoded=a+'\n'+b+'\n'),'retries: 2\n')
    else:
        a,b=rand(10),rand(10)
        raw='  '+a+'\n  '+b+'\n'
        add('multiline','yaml-literal-strip','Repair this YAML config loader:\npassword: |-\n',secret(raw,'yaml',decoded=a+'\n'+b),'retries: 2\n')

for j in range(12):
    value=rand(18)+'!'
    s=secret(value,'prose')
    family=['repeat-handoff','repeat-log','repeat-review'][j%3]
    add('repeated-values',family,'The actual password is "',s,'". The failed run also logged password="',s,'". Reproduce with "',s,'" and stop logging it.')
for j in range(12):
    a,b=rand(18),rand(19)
    family=['adjacent-env','adjacent-json','adjacent-curl'][j%3]
    if j%3==0:
        add('adjacent-values',family,'Use these two independent service secrets:\nAPI_TOKEN=',secret(a,'env-assignment','generic-token'),'\nDB_PASSWORD=',secret(b,'env-assignment'),'\n')
    elif j%3==1:
        add('adjacent-values',family,'Review this paired config:\n{"token":"',secret(a,'json-string','generic-token'),'","password":"',secret(b,'json-string'),'"}')
    else:
        add('adjacent-values',family,'Debug this request with two headers:\ncurl https://api.invalid -H "Authorization: Bearer ',secret(a,'header','generic-token'),'" -H "X-API-Key: ',secret(b,'header','generic-token'),'"')

for j in range(12):
    value=rand(15)+'.'
    add('meaningful-punctuation',['password-terminal-dot','password-terminal-colon','password-terminal-semicolon'][j%3],
        'Use the exact password enclosed in these quotes, including the last character: "',
        secret(value[:-1]+['.',':',';'][j%3],'prose'),'". Investigate the authentication failure.')
for j in range(12):
    add('generic-prose',['prose-support','prose-review','prose-task'][j%3],
        ['Support handed me the actual integration token «','During review I received this live staging password «','Implement the client using this temporary access secret «'][j%3],
        secret(rand(22)+'!?','prose','generic-token'),'». Keep it available for the repro.')
for j in range(9):
    enc=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
    header=enc(b'{"alg":"HS256","typ":"JWT"}')
    payload=enc(json.dumps({'sub':'synthetic-'+rand(8),'aud':'eval.invalid','exp':2000000000},separators=(',',':')).encode())
    data=header+'.'+payload
    value=data+'.'+enc(hmac.new(rand(32).encode(),data.encode(),hashlib.sha256).digest())
    add('jwt',['jwt-header','jwt-task','jwt-log'][j%3],'Reproduce the API call with this signed synthetic session token:\nAuthorization: Bearer ',secret(value,'header','jwt'),'\n')

# Exact byte lengths and offsets. Padding is realistic repeated benign build output.
def padding(n):
    line='build: asset compilation completed successfully; cache hit\n'
    return (line*((n//len(line))+1))[:n]
def long_case(n, pos, family, boundary=None):
    value='edge-'+rand(20)+'!'
    lead='Actual password: "'
    trailer='"\n'
    if pos=='start':
        # A literal at byte zero, with following context identifying it.
        parts=[secret(value,'plain'), '\nThe preceding line is the actual deployment password.\n']
        parts.append(padding(n-sum(len(x['raw'] if isinstance(x,dict) else x) for x in parts)))
    elif pos=='end':
        # No closing delimiter: the value occupies the final bytes.
        prefix='The final line contains the actual deployment password:\nPASSWORD='
        parts=[padding(n-len(prefix)-len(value)),prefix,secret(value,'env-assignment')]
    else:
        start=(n//2 if pos=='middle' else boundary-len(value)//2)
        prefix=padding(start-len(lead))+lead
        parts=[prefix,secret(value,'prose'),trailer,padding(n-start-len(value)-len(trailer))]
    add('length',family,*parts,over_limit=n>16384,byte_length=n,position=pos,**({'boundary':boundary} if boundary else {}))
    assert len(rows[-1]['text'].encode())==n
    s=rows[-1]['secrets'][0]
    if boundary: assert s['start']<boundary<s['end']
for pos in ['start','middle','end']:
    long_case(16384,pos,'length-'+pos)
for boundary in range(512,16384,512):
    long_case(16384,'straddle','length-straddle-512',boundary)
long_case(32768,'end','length-double-limit')
long_case(16385,'end','length-one-over')
long_case(32769,'end','length-double-one-over')

# Clean prompts have varied ordinary contexts, not a shared appended request identifier.
for j in range(16):
    sha=rand(40,'0123456789abcdef')
    uid='-'.join(rand(n,'0123456789abcdef') for n in [8,4,4,4,12])
    blob=base64.b64encode(bytes(rng.randrange(256) for _ in range(72))).decode()
    digest=hashlib.sha512(str(j).encode()).hexdigest()
    cases=[
        ('git-sha','git-review',f'Review commit {sha} against its parent; focus on event dispatch in renderer_{j}.go.'),
        ('uuid','uuid-log',f'Debug: job_id={uid}\nstate=queued\nattempt={j}\nThis is a public job identifier, not an auth token.'),
        ('request-id','request-trace',f'Traceback: upstream timeout\nX-Request-ID: req_{rand(32)}\nGET /public/health\nPlease identify the retry path.'),
        ('base64-data','image-fixture',f'This public thumbnail fixture is a binary payload, not a credential:\nconst thumbnail = "{blob}";\nExplain base64 decoding.'),
        ('lockfile-hash','lockfile-review',f'Review this lockfile excerpt:\npackage: widget-{j}\nchecksum: sha512-{base64.b64encode(bytes.fromhex(digest)).decode()}\nresolved: https://registry.invalid/widget.tgz'),
        ('fixture-entropy','randomized-test',f'The fuzz test uses noncredential random bytes as expected packet data:\nexpected_payload = "{rand(96)}"\nWrite an assertion for its length.'),
        ('public-url','url-task',f'Add cache headers to https://docs.invalid/v{j}/guide?topic=install&lang=en#examples. No authentication is required.'),
        ('env-names','env-schema',f'Document these environment variable names only:\nAPI_KEY\nDATABASE_PASSWORD\nHF_TOKEN\nSTRIPE_SECRET_KEY\nNo values are provided. Revision {j}.'),
        ('template-reference','dollar-template',f'Fix variable expansion in deployment step {j}:\ncurl -H "Authorization: Bearer ${{API_KEY}}" https://api.invalid\nUse the existing environment binding.'),
        ('template-reference','go-template',f'Review Helm output for replica count {j}:\napiToken: "{{{{ .Token }}}}"\npassword: "{{{{ .Values.database.password }}}}"'),
        ('function-reference','python-env-call',f'Explain this config reader for worker {j}:\npassword = os.getenv("X")\ntoken = os.environ.get("API_TOKEN")\nNo literal credential is present.'),
        ('placeholder','angle-placeholder',f'Update README section {j}:\nAPI_TOKEN=<your-token>\nPASSWORD=<your-password>\nThese are substitution instructions.'),
        ('placeholder','redacted-log',f'Inspect sanitized report {j}:\nAuthorization: Bearer REDACTED\npassword=****\nAll credential bytes were removed before export.'),
        ('prose-nonvalue','secret-length',f'The secret is 42 lines long. The token is stored in the keychain. Please repair editor line wrapping for pane {j}; no credential value is included.'),
        ('prose-nonvalue','password-guidance',f'Password policy revision {j}: passwords should contain punctuation. The API key is a string. The password is not shown.'),
        ('hash','artifact-hash',f'Verify public release artifact {j} against SHA-512 {digest}; this digest is an integrity checksum.'),
        ('source-code','function-tokenizer',f'Review lexer test {j}:\nconst token = nextToken(input);\nconst password = config.lookup("db.password");\nDo not evaluate these expressions.'),
        ('public-config','plain-settings',f'Fix app startup:\nPORT={8000+j}\nLOG_LEVEL=debug\nPUBLIC_ORIGIN=https://demo.invalid\nRETRY_COUNT=4\n'),
        ('unicode-clean','unicode-documentation',f'🛠 Révision {j}: explain UTF-16 offsets for é, 終 and 🔐. The key icon labels the settings tab.'),
        ('crlf-clean','windows-clean-log',f'Windows build {j}\r\ncompile: OK\r\ncache: HIT\r\npath: C:\\work\\renderer\r\nPlease diagnose slow startup.'),
    ]
    for category,family,text in cases:
        add('clean-'+category,family,text)

# Assertions are deliberately independent of any detector implementation.
def verify(data):
    ids=set()
    for row in data:
        assert row['id'] not in ids
        ids.add(row['id'])
        text=row['text']; b=text.encode('utf-8'); previous=0
        assert row['split']==('positive' if row['secrets'] else 'clean')
        assert row.get('over_limit',False)==(len(b)>16384)
        for s in row['secrets']:
            assert previous<=s['start']<s['end']<=len(b)
            assert b[s['start']:s['end']]==s['raw'].encode('utf-8')
            assert len(b[:s['start']].decode().encode('utf-16-le'))//2==s['start_u16']
            assert len(b[:s['end']].decode().encode('utf-16-le'))//2==s['end_u16']
            assert text.encode('utf-16-le')[2*s['start_u16']:2*s['end_u16']].decode('utf-16-le')==s['raw']
            if s['syntax']=='json-string': assert json.loads('"'+s['raw']+'"')==s['decoded']
            if s['syntax'] in ('url-query','url-userinfo'): assert urllib.parse.unquote(s['raw'])==s['decoded']
            if s['syntax']=='shell-single':
                assert shlex.split("'"+s['raw']+"'")==[s['decoded']]
            if s['syntax']=='shell-double':
                # Decode only the POSIX backslash rules; generated inputs have no expansions.
                out=''; k=0
                while k<len(s['raw']):
                    if s['raw'][k]=='\\' and k+1<len(s['raw']) and s['raw'][k+1] in '\\$`"\n':
                        k+=1
                        if s['raw'][k]!='\n': out+=s['raw'][k]
                    else: out+=s['raw'][k]
                    k+=1
                assert out==s['decoded']
            if s['syntax']=='yaml':
                decoded=''.join(line[2:] for line in s['raw'].splitlines(keepends=True))
                if row['family']=='yaml-literal-strip': decoded=decoded.rstrip('\n')
                assert decoded==s['decoded']
            previous=s['end']
    counts=Counter(x['split'] for x in data)
    assert counts['positive']>=250 and counts['clean']>=300
    assert sum(len(x['secrets']) for x in data)>=300
    assert {x['boundary'] for x in data if 'boundary' in x}==set(range(512,16384,512))
    assert len({x['text'] for x in data if x['split']=='clean'})==counts['clean']

verify(rows)
corpus=''.join(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n' for r in rows).encode('utf-8')
(ROOT/'corpus.jsonl').write_bytes(corpus)
verify([json.loads(line) for line in corpus.decode().splitlines()])
manifest={
    'date':DATE,'seed':SEED,'sha256':hashlib.sha256(corpus).hexdigest(),
    'prompts':len(rows),'secret_occurrences':sum(len(x['secrets']) for x in rows),
    'counts_per_split':dict(Counter(x['split'] for x in rows)),
    'counts_per_category':dict(sorted(Counter(x['category'] for x in rows).items())),
    'counts_per_family':dict(sorted(Counter(x['family'] for x in rows).items())),
    'counts_per_kind':dict(sorted(Counter(s['kind'] for x in rows for s in x['secrets']).items())),
    'occurrences_per_category':dict(sorted(Counter(x['category'] for x in rows for _ in x['secrets']).items())),
    'occurrences_per_syntax':dict(sorted(Counter(s['syntax'] for x in rows for s in x['secrets']).items())),
    'over_limit_prompts':sum(x.get('over_limit',False) for x in rows),
    'in_limit_positive_prompts':sum(x['split']=='positive' and not x.get('over_limit',False) for x in rows),
    'in_limit_occurrences':sum(len(x['secrets']) for x in rows if not x.get('over_limit',False)),
    'boundary_bytes':list(range(512,16384,512)),
    'provider_validity':'Lexical grammar only, as documented in sources.md; never verified with a provider.',
}
(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps({k:manifest[k] for k in ['prompts','secret_occurrences','counts_per_split','sha256','over_limit_prompts']}))
