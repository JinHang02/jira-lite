#!/bin/sh
# Create a local certificate authority (once) and a server certificate signed by it.
# Usage: scripts/make-cert.sh [host-or-ip ...]   e.g. scripts/make-cert.sh 192.168.0.113 MacBook-Pro-2.local
# Colleagues trust certs/ca.crt once; regenerating the server cert for a new IP needs no re-trust.
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
umask 077

if [ ! -f certs/ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout certs/ca.key -out certs/ca.crt -subj "/CN=jira-lite local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  echo "Created certs/ca.crt (share this file with colleagues to trust once)"
fi

san="DNS:localhost,IP:127.0.0.1"
for h in "$@"; do
  case "$h" in
    localhost|127.0.0.1) ;;
    *[!0-9.]*) san="$san,DNS:$h" ;;
    *) san="$san,IP:$h" ;;
  esac
done

openssl req -newkey rsa:2048 -nodes -sha256 -keyout certs/server.key -out certs/server.csr -subj "/CN=jira-lite" 2>/dev/null
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' "$san" > certs/server.ext
# 825 days is the longest validity macOS/iOS accept for TLS server certificates.
openssl x509 -req -sha256 -days 825 -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -out certs/server.crt -extfile certs/server.ext 2>/dev/null
rm -f certs/server.csr certs/server.ext
echo "Created certs/server.crt for $san"
