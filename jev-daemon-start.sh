#!/bin/sh
# Starts the jev-router daemon from the extension-routing-daemon worktree.
# Usage: jev-daemon-start.sh [--port N]
exec node /Users/it/Documents/MySource/jev-router/.worktrees/extension-routing-daemon/bin/jev-daemon.mjs start "$@"
