#!/bin/bash
# Starts readm3 with the strongest Chromium sandbox this system allows.
#
# build.mjs puts this script where electron-builder put the Electron binary and
# renames the binary to readm3-desktop.bin, so the AppImage and the .desktop
# entry run this first. Chromium needs either the namespace sandbox (unprivileged
# user namespaces) or the SUID helper (chrome-sandbox owned by root, mode 4755).
# An AppImage can have neither on Ubuntu 24.04+: AppArmor restricts user
# namespaces for unconfined binaries, and a FUSE mount is nosuid. Without this,
# the app aborts before it draws anything:
#
#   FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found,
#   but is not configured correctly.
set -eu
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
app="$here/readm3-desktop.bin"

# Flatpak sandboxes Chromium itself through zypak; never weaken that.
if [ -f /.flatpak-info ]; then exec "$app" "$@"; fi

sandbox_unavailable() {
  [ -u "$here/chrome-sandbox" ] && [ "$(stat -c %u "$here/chrome-sandbox")" = 0 ] && return 1
  # `unshare --user true` succeeds under Ubuntu's AppArmor policy even when an
  # unconfined binary like this one is denied, so read the policy directly.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    return 0
  fi
  unshare --user true >/dev/null 2>&1 && return 1
  return 0
}

if sandbox_unavailable; then
  echo "readm3: this system allows neither of Chromium's sandboxes to an AppImage;" >&2
  echo "        starting without it. The Flatpak build keeps the sandbox." >&2
  exec "$app" --no-sandbox "$@"
fi
exec "$app" "$@"
