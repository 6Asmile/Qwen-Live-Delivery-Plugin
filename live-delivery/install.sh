#!/bin/sh
set -eu
cd_setup_root=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$cd_setup_root/dist/setup.mjs" "$@"
