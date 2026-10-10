#!/bin/sh
# QSYN OpenAlgo host capability inventory (read-only).
# No network calls, process starts, privilege escalation, file mutation or secret output.
set -eu
umask 077

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: sh host-readiness.sh (no arguments)' >&2
  exit 2
fi

available() {
  command -v "$1" >/dev/null 2>&1
}

os=other
if available uname; then
  case "$(uname -s 2>/dev/null || true)" in
    Linux) os=linux ;;
  esac
fi

python_command=none
python_version=unknown
python_312=missing
python_venv=not_checked
python_ssl=not_checked
python_sqlite=not_checked
for candidate in python3.12 python3 python; do
  if available "$candidate" && "$candidate" -c 'import sys; assert sys.version_info >= (3, 12)' >/dev/null 2>&1; then
    python_command=$candidate
    python_version=$("$candidate" -c 'import sys; print("%s.%s.%s" % sys.version_info[:3])' 2>/dev/null || printf unknown)
    python_312=pass
    if "$candidate" -c 'import venv' >/dev/null 2>&1; then python_venv=pass; else python_venv=missing; fi
    if "$candidate" -c 'import ssl' >/dev/null 2>&1; then python_ssl=pass; else python_ssl=missing; fi
    if "$candidate" -c 'import sqlite3' >/dev/null 2>&1; then python_sqlite=pass; else python_sqlite=missing; fi
    break
  fi
done

process_manager=none_detected
if available supervisorctl; then
  process_manager=supervisorctl_binary_present
elif available systemctl; then
  process_manager=systemctl_binary_present
fi

runtime_user=unknown
if available id; then
  uid=$(id -u 2>/dev/null || printf unknown)
  case "$uid" in
    0) runtime_user=root ;;
    unknown) runtime_user=unknown ;;
    *[!0-9]*) runtime_user=unknown ;;
    *) runtime_user=nonroot ;;
  esac
fi

printf '%s\n'   'report_schema=QSYN-OPENALGO-HOST-READINESS/1'   "os=$os"   "runtime_user=$runtime_user"   "python_command=$python_command"   "python_version=$python_version"   "python_312=$python_312"   "python_venv=$python_venv"   "python_ssl=$python_ssl"   "python_sqlite=$python_sqlite"   "process_manager=$process_manager"   'manager_authorization=UNVERIFIED'   'persistent_private_storage=UNVERIFIED'   'http_tls_proxy=UNVERIFIED'   'websocket_upgrade=UNVERIFIED'   'broker_egress=UNVERIFIED'   'reboot_recovery=UNVERIFIED'   'host_approved=NO'

# Intentionally return 0 for a complete inventory even if no compatible Python
# is found. A generated report is not an approval or service-readiness proof.
