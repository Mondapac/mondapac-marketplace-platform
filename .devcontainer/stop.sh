#!/usr/bin/env bash
# Stops what .devcontainer/start.sh started. PostgreSQL and its data stay.
cd "$(dirname "$0")/.." || exit 1
for pidfile in .local/logs/*.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  # setsid made each process the leader of its own group: stop the whole group.
  kill -TERM -- "-$pid" 2>/dev/null && echo "stopped $(basename "$pidfile" .pid)"
  rm -f "$pidfile"
done
