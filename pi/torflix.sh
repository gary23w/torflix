#!/bin/bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Starts Torflix on the console: the TV shell, which starts the backend on Torflix's own Node.
here="$(dirname "$(readlink -f "$0")")"
exec python3 "$here/torflix-tv.py" "$@"
