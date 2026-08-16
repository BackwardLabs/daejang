#!/bin/sh

find_tailscale_cli() {
  if [ -n "${TAILSCALE_CLI:-}" ] && [ -x "$TAILSCALE_CLI" ]; then
    printf '%s\n' "$TAILSCALE_CLI"
    return
  fi

  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return
  fi

  macos_cli=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  if [ -x "$macos_cli" ]; then
    printf '%s\n' "$macos_cli"
    return
  fi

  echo "Tailscale CLI was not found. Set TAILSCALE_CLI in .env." >&2
  return 1
}

tailscale_dns_name() {
  tailscale_cli=$1

  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to read the Tailscale DNS name." >&2
    return 1
  fi

  status_json=$("$tailscale_cli" status --json)
  backend_state=$(printf '%s' "$status_json" | jq -r '.BackendState // empty')
  if [ "$backend_state" != "Running" ]; then
    echo "Tailscale is not connected (state: ${backend_state:-unknown})." >&2
    return 1
  fi

  dns_name=$(printf '%s' "$status_json" | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
  if [ -z "$dns_name" ]; then
    echo "Tailscale MagicDNS did not return a hostname." >&2
    return 1
  fi

  printf '%s\n' "$dns_name"
}
