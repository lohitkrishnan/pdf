#!/usr/bin/env python3
"""Regenerate the offline file list and cache version in sw.js.

Run this before every commit that changes a file the app loads:

    python3 tools/update-sw.py

The version is a hash of every cached file, so any change makes browsers fetch the new
version once and keeps the old one working until the user reloads.
"""
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Files the app needs at runtime. Everything tracked by git is included except these.
EXCLUDE = re.compile(r'^(\.|README|tools/|tests?/|sw\.js$|img/og-card|.*LICENSE|.*OFL\.txt$)')


def main():
    files = subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    new = subprocess.run(['git', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    files = sorted({f for f in files + new if (ROOT / f).is_file() and not EXCLUDE.match(f)})
    h = hashlib.sha256()
    for f in files:
        h.update(f.encode())
        h.update((ROOT / f).read_bytes())
    version = h.hexdigest()[:12]
    sw = ROOT / 'sw.js'
    text = sw.read_text()
    text = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", text)
    listing = json.dumps(['./'] + [f'./{f}' for f in files if f != 'index.html'], indent=4).replace('"', "'")
    text = re.sub(r'const FILES = \[[^\]]*\];', f'const FILES = {listing};', text, flags=re.S)
    sw.write_text(text)
    total = sum((ROOT / f).stat().st_size for f in files)
    print(f'sw.js: version {version}, {len(files)} files, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
