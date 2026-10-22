#!/usr/bin/env bash
set -euo pipefail
# The environment holds public packages only and must be readable by a dedicated
# service account even when an administrator installs it. Runtime data uses 0077.
umask 022
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_python=${PYTHON:-python3}
if [[ -L "$task_root/.venv" ]]; then
  echo "Refusing a symlinked collector virtual environment" >&2
  exit 1
fi
"$task_python" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
"$task_python" -m venv "$task_root/.venv"
"$task_root/.venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes -r "$task_root/collector/requirements.lock"
chmod -R a+rX "$task_root/.venv"
"$task_root/.venv/bin/python" -I "$task_root/collector/bridge.py" --version
