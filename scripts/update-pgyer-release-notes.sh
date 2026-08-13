#!/usr/bin/env bash

set -euo pipefail

shortcut="${PGYER_SHORTCUT:-flowlet-android}"
release_notes="${RELEASE_NOTES:-}"
release_notes="$(printf '%s' "$release_notes" | python3 scripts/format-pgyer-release-notes.py)"

for variable in PGYER_API_KEY PGYER_USER_KEY; do
  if [ -z "${!variable:-}" ]; then
    echo "Required environment variable is missing: $variable" >&2
    exit 1
  fi
done

lookup_response="$(curl --fail-with-body --silent --show-error \
  --retry 3 \
  --retry-delay 3 \
  --retry-all-errors \
  --connect-timeout 20 \
  --max-time 60 \
  --request POST 'https://www.pgyer.com/apiv2/app/getByShortcut' \
  --data-urlencode "_api_key=$PGYER_API_KEY" \
  --data-urlencode "buildShortcutUrl=$shortcut")"

lookup_code="$(jq -r '.code // -1' <<<"$lookup_response")"
if [ "$lookup_code" != "0" ]; then
  lookup_message="$(jq -r '.message // "Unknown Pgyer lookup error"' <<<"$lookup_response")"
  echo "Pgyer app lookup failed: $lookup_message (code $lookup_code)" >&2
  exit 1
fi

build_key="$(jq -r '.data.buildKey // empty' <<<"$lookup_response")"
if [ -z "$build_key" ]; then
  echo "Pgyer app lookup did not return a build key" >&2
  exit 1
fi

update_response="$(curl --fail-with-body --silent --show-error \
  --retry 3 \
  --retry-delay 3 \
  --retry-all-errors \
  --connect-timeout 20 \
  --max-time 60 \
  --request POST 'https://www.pgyer.com/apiv2/app/updateApp' \
  --data-urlencode "_api_key=$PGYER_API_KEY" \
  --data-urlencode "userKey=$PGYER_USER_KEY" \
  --data-urlencode "buildKey=$build_key" \
  --data-urlencode "buildUpdateDescription=$release_notes")"

update_code="$(jq -r '.code // -1' <<<"$update_response")"
if [ "$update_code" != "0" ]; then
  update_message="$(jq -r '.message // "Unknown Pgyer update error"' <<<"$update_response")"
  echo "Pgyer release-notes update failed: $update_message (code $update_code)" >&2
  exit 1
fi

version="$(jq -r '.data.buildVersion // empty' <<<"$update_response")"
echo "Updated Pgyer release notes for Flowlet ${version}: https://www.pgyer.com/${shortcut}"
