#!/usr/bin/env bash
# One-time setup for the conformance-vector toolchain (Python: rfc8785 + cryptography).
# After this, `npm run demo:metered` emits and checks the settlement-receipt vector.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt
echo "vectors toolchain ready (.venv) — run: npm run demo:metered"
