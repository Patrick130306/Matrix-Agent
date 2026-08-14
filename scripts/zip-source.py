"""打包源码压缩包到 release/ (排除 node_modules/dist/release/.git/logs/profiles)。"""
import os
import zipfile

SRC = r'D:\kimi_workspaces\matrix_agent\matrix-agent'
OUT = os.path.join(SRC, 'release', 'matrix-agent-source.zip')
EXCLUDE_DIRS = {'node_modules', 'release', 'dist', '.git', 'logs', 'profiles'}
EXCLUDE_FILES = {'release-log.txt'}

files = []
for root, dirs, names in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
    for n in names:
        if n in EXCLUDE_FILES:
            continue
        fp = os.path.join(root, n)
        rel = os.path.relpath(fp, SRC)
        files.append((fp, os.path.join('matrix-agent', rel)))

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for fp, rel in sorted(files):
        z.write(fp, rel)

total = sum(os.path.getsize(fp) for fp, _ in files)
print(f'文件数: {len(files)}, 源码总大小: {total/1024:.0f} KB, 压缩包: {os.path.getsize(OUT)/1024:.0f} KB')
print(f'输出: {OUT}')
