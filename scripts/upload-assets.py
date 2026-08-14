"""只上传资产到已存在的 v0.3.0 release(可重跑,已存在资产自动跳过)"""
import json, os, urllib.request, urllib.error
from urllib.parse import quote

TOKEN = open(r'D:\kimi_workspaces\matrix_agent\matrix-agent\.gh_token.tmp').read().strip()
REPO = 'Patrick130306/Matrix-Agent'
BASE = 'https://api.github.com'
PROXY = 'http://127.0.0.1:7877'

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY})
)

def gh(method, url, data=None, headers=None, binary=None):
    h = {
        'Authorization': f'token {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'hermes-release',
    }
    if headers: h.update(headers)
    body = binary if binary is not None else (json.dumps(data).encode() if data is not None else None)
    if body and binary is None:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with opener.open(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# 找到已有 release
st, rel = gh('GET', f'{BASE}/repos/{REPO}/releases/tags/v0.3.0')
if st != 200:
    print('release not found:', st, str(rel)[:300]); raise SystemExit(1)
upload_url = rel['upload_url'].split('{')[0]
existing = {a['name'] for a in rel.get('assets', [])}
print('existing assets:', existing)

release_dir = r'D:\kimi_workspaces\matrix_agent\matrix-agent\release'
assets = [
    ('Matrix Agent Setup 0.3.0.exe', 'application/x-msdownload'),
    ('Matrix Agent Setup 0.3.0.exe.blockmap', 'application/octet-stream'),
    ('matrix-agent-0.3.0-source.zip', 'application/zip'),
]
for name, ctype in assets:
    if name in existing:
        print(f'skip {name} (已存在)')
        continue
    path = os.path.join(release_dir, name)
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        data = f.read()
    url = f'{upload_url}?name={quote(name)}'
    st2, r2 = gh('POST', url, binary=data, headers={'Content-Type': ctype})
    print(f'upload {name} ({size/1024/1024:.1f}MB): {st2}')
    if st2 != 201:
        print(str(r2)[:500])
