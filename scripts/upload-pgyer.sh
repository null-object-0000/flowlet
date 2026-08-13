#!/usr/bin/env bash

set -euo pipefail

apk_path="${1:-}"
release_notes="${RELEASE_NOTES:-}"
release_notes="$(printf '%s' "$release_notes" | python3 scripts/format-pgyer-release-notes.py)"

if [ -z "${PGYER_API_KEY:-}" ]; then
  echo "Required environment variable is missing: PGYER_API_KEY" >&2
  exit 1
fi

if [ -z "$apk_path" ] || [ ! -f "$apk_path" ]; then
  echo "Android APK was not found for Pgyer upload: $apk_path" >&2
  exit 1
fi

token_response="$(curl --fail-with-body --silent --show-error \
  --request POST 'https://www.pgyer.com/apiv2/app/getCOSToken' \
  --data-urlencode "_api_key=$PGYER_API_KEY" \
  --data-urlencode 'buildType=apk' \
  --data-urlencode 'buildInstallType=1' \
  --data-urlencode 'buildInstallDate=2' \
  --data-urlencode "buildUpdateDescription=$release_notes")"

token_code="$(jq -r '.code // -1' <<<"$token_response")"
if [ "$token_code" != "0" ]; then
  token_message="$(jq -r '.message // "Unknown Pgyer token error"' <<<"$token_response")"
  echo "Pgyer rejected the upload request: $token_message (code $token_code)" >&2
  exit 1
fi

endpoint="$(jq -r '.data.endpoint // empty' <<<"$token_response")"
build_key="$(jq -r '.data.key // empty' <<<"$token_response")"
signature="$(jq -r '.data.params.signature // empty' <<<"$token_response")"
security_token="$(jq -r '.data.params["x-cos-security-token"] // empty' <<<"$token_response")"
upload_key="$(jq -r '.data.params.key // empty' <<<"$token_response")"

if [ -z "$endpoint" ] || [ -z "$build_key" ] || [ -z "$signature" ] || [ -z "$security_token" ] || [ -z "$upload_key" ]; then
  echo "Pgyer returned an incomplete upload token" >&2
  exit 1
fi

upload_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  --form-string "key=$upload_key" \
  --form-string "signature=$signature" \
  --form-string "x-cos-security-token=$security_token" \
  --form-string "x-cos-meta-file-name=$(basename "$apk_path")" \
  --form "file=@$apk_path" \
  "$endpoint")"

if [ "$upload_status" != "204" ]; then
  echo "Pgyer file upload failed with HTTP status $upload_status" >&2
  exit 1
fi

for attempt in $(seq 1 40); do
  build_response="$(curl --fail-with-body --silent --show-error \
    --get 'https://www.pgyer.com/apiv2/app/buildInfo' \
    --data-urlencode "_api_key=$PGYER_API_KEY" \
    --data-urlencode "buildKey=$build_key")"
  build_code="$(jq -r '.code // -1' <<<"$build_response")"

  if [ "$build_code" = "0" ]; then
    shortcut="$(jq -r '.data.buildShortcutUrl // empty' <<<"$build_response")"
    version="$(jq -r '.data.buildVersion // empty' <<<"$build_response")"
    echo "Pgyer published Flowlet ${version}: https://www.pgyer.com/${shortcut}"
    exit 0
  fi

  if [ "$build_code" != "1247" ]; then
    build_message="$(jq -r '.message // "Unknown Pgyer publishing error"' <<<"$build_response")"
    echo "Pgyer publishing failed: $build_message (code $build_code)" >&2
    exit 1
  fi

  echo "Pgyer is processing the APK (${attempt}/40)..."
  sleep 5
done

echo "Timed out waiting for Pgyer to publish the APK" >&2
exit 1
