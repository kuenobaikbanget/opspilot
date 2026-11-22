#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf 'OpsPilot: %s\n' "$1" >&2; exit 1; }
(( $# == 4 )) || fail 'Usage: bash ./infra/install/agent-dev.sh HUB_ORIGIN RELEASE_TAG OWNER/REPO TOKEN'
hub_url=$1 version=$2 repository=$3 token=$4
set --

uid=$(id -u)
[[ "$uid" != 0 ]] || fail 'Run this development command as a non-root user, without sudo'
loopback_pattern='^http://127\.0\.0\.1(:([1-9][0-9]{0,4}))?$'
[[ "$hub_url" =~ $loopback_pattern ]] || fail 'Expected an HTTP origin on 127.0.0.1'
(( ${BASH_REMATCH[2]:-80} <= 65535 )) || fail 'Hub URL has an invalid port'
version_pattern='^v[0-9]+\.[0-9]+\.[0-9]+(-([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)?$'
[[ "$version" =~ $version_pattern ]] || fail 'Expected a pinned release tag'
repository_pattern='^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
[[ "$repository" =~ $repository_pattern && "${repository#*/}" != . && "${repository#*/}" != .. ]] || fail 'Expected a GitHub OWNER/REPO'

case "$(uname -sm)" in
  'Linux x86_64'|'Linux amd64') arch=amd64 ;;
  'Linux aarch64'|'Linux arm64') arch=arm64 ;;
  *) fail 'Requires amd64 or arm64 Linux' ;;
esac

dir=$(mktemp -d)
trap 'rm -rf -- "$dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
archive="opspilot-agent_${version#v}_linux_${arch}.tar.gz"
release="https://github.com/$repository/releases/download/$version"
download() {
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --noproxy '*' --connect-timeout 10 --max-time 120 --output "$dir/$1" "$release/$1"
}
download "$archive"
download SHA256SUMS
checksum=$(LC_ALL=C awk -v archive="$archive" '
  $2 == archive || $2 == "*" archive {
    count++
    if (NF == 2 && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/) hash = $1
  }
  END { if (count != 1 || hash == "") exit 1; print hash }
' "$dir/SHA256SUMS") || fail 'Expected exactly one valid release checksum'
(cd -- "$dir"; printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c)
TAR_OPTIONS= tar -xOzf "$dir/$archive" -- opspilot-agent > "$dir/opspilot-agent"
test -s "$dir/opspilot-agent"
chmod u+x "$dir/opspilot-agent"
env -i PATH="$PATH" OPSPILOT_HUB_URL="$hub_url" OPSPILOT_ENROLL_TOKEN="$token" \
  OPSPILOT_AGENT_STATE_PATH="$dir/identity.json" "$dir/opspilot-agent"
