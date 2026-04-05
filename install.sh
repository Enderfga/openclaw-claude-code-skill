#!/usr/bin/env bash
# One-line installer for openclaw-claude-code
# Usage: curl -fsSL https://raw.githubusercontent.com/Enderfga/openclaw-claude-code/main/install.sh | bash
set -euo pipefail

NPM_PACKAGE="@enderfga/openclaw-claude-code"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────
command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node.js first: https://nodejs.org"
command -v openclaw >/dev/null 2>&1 || fail "openclaw not found. Install OpenClaw first: https://docs.openclaw.ai"

# ── Step 1: npm global install ───────────────────────────
info "Installing ${NPM_PACKAGE} via npm..."
npm install -g "${NPM_PACKAGE}" --silent 2>&1 | tail -1

PKG_PATH="$(npm root -g)/${NPM_PACKAGE}"
[ -d "${PKG_PATH}" ] || fail "npm install succeeded but package not found at ${PKG_PATH}"

VERSION="$(node -e "console.log(require('${PKG_PATH}/package.json').version)")"
ok "Installed v${VERSION} at ${PKG_PATH}"

# ── Step 2: Register in openclaw.json via plugins.load.paths ──
if [ ! -f "${CONFIG_FILE}" ]; then
    warn "openclaw.json not found at ${CONFIG_FILE}"
    warn "Add this to your openclaw.json manually:"
    echo ""
    echo '  "plugins": { "load": { "paths": ["'"${PKG_PATH}"'"] } }'
    echo ""
else
    info "Configuring openclaw.json..."
    python3 -c "
import json, sys

with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)

plugins = cfg.setdefault('plugins', {})
load = plugins.setdefault('load', {})
paths = load.setdefault('paths', [])

pkg_path = '${PKG_PATH}'

# Check if already registered (exact match or different path to same package)
already = False
for p in paths:
    if p == pkg_path:
        already = True
        break
    # Also match if an existing path ends with the package name
    if p.endswith('/openclaw-claude-code'):
        print(f'Replacing existing path: {p}')
        paths[paths.index(p)] = pkg_path
        already = True
        break

if not already:
    paths.append(pkg_path)

# Remove stale entries.openclaw-claude-code if present (doesn't work without load.paths)
entries = plugins.get('entries', {})
if 'openclaw-claude-code' in entries:
    del entries['openclaw-claude-code']
    print('Removed stale plugins.entries.openclaw-claude-code')

with open('${CONFIG_FILE}', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>&1 && ok "Plugin registered in plugins.load.paths" \
         || { warn "Auto-configure failed. Add manually to openclaw.json:"; echo '  "plugins": { "load": { "paths": ["'"${PKG_PATH}"'"] } }'; }
fi

# ── Step 3: Restart gateway ──────────────────────────────
echo ""
info "Restarting OpenClaw gateway..."
if openclaw gateway restart 2>&1 | grep -q "Restarted"; then
    ok "Gateway restarted"
else
    warn "Gateway restart may have failed — try: openclaw gateway restart"
fi

# ── Step 4: Verify ───────────────────────────────────────
sleep 2
info "Verifying..."
if openclaw plugins list 2>/dev/null | grep -q "claude-code"; then
    ok "openclaw-claude-code is loaded and ready!"
else
    warn "Plugin may need a moment to load. Check with: openclaw plugins list"
fi

echo ""
ok "Done! You now have claude_session_start, council_start, and 20+ coding agent tools."
echo "  Docs: https://github.com/Enderfga/openclaw-claude-code"
