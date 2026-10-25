#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cleanup() { docker rm -f wallet-web wallet-api wallet-pg >/dev/null 2>&1 || true; docker network rm wallet-smoke >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker build -t wallet-api-smoke -f apps/api/Dockerfile.production apps/api
docker build -t wallet-web-smoke -f apps/web/Dockerfile.production apps/web
docker network create wallet-smoke >/dev/null
docker run -d --name wallet-pg --network wallet-smoke -e POSTGRES_USER=wallet -e POSTGRES_PASSWORD=smoke_test_only -e POSTGRES_DB=wallet postgres:17 >/dev/null
# Same network namespace models both containers inside one Container App.
# Test fixture uses plaintext PostgreSQL only on this isolated Docker network.
docker run -d --name wallet-api --network wallet-smoke -p 127.0.0.1:8080:8080 -e NODE_ENV=test -e DB_SSL=false -e DB_HOST=wallet-pg -e DB_NAME=wallet -e DB_USER=wallet -e DB_PASSWORD=smoke_test_only -e WALLET_ORIGIN=http://localhost:8080 wallet-api-smoke >/dev/null
docker run -d --name wallet-web --network container:wallet-api wallet-web-smoke >/dev/null
for attempt in {1..60}; do
  if curl -fsS http://localhost:8080/ready >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then echo 'Production container startup failed'; docker logs wallet-api; exit 1; fi
  sleep 2
done
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const root='http://localhost:8080';
const network=await fetch(root+'/api/v1/network');
assert.equal(network.status,200); assert.equal((await network.json()).network,'TESTNET');
const page=await fetch(root+'/activity');
assert.equal(page.status,200); assert.match(await page.text(),/<div id="root">/);
assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
const closed=await fetch(root+'/api/v1/wallets/unknown/attempts');
assert.equal(closed.status,503);
const wrong=await fetch(root+'/api/v1/passkeys/registration/options',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
assert.equal(wrong.status,403);
// Azure appends the real address after any client-supplied spoofed prefix.
const enroll=async ip=>fetch(root+'/api/v1/passkeys/registration/options',{method:'POST',headers:{origin:root,'content-type':'application/json','x-forwarded-for':`192.0.2.99, ${ip}`},body:'{}'});
for(let i=0;i<10;i++) assert.equal((await enroll('192.0.2.1')).status,200);
assert.equal((await enroll('192.0.2.1')).status,429);
assert.equal((await enroll('192.0.2.2')).status,200);
console.log('Compiled API, migrations, SPA, same-origin API, disabled payments, origin and proxy rate limits passed');
JS
docker stop wallet-pg >/dev/null
status=$(curl -s -o /tmp/wallet-readiness.json -w '%{http_code}' http://localhost:8080/ready)
[[ "$status" == 503 ]]
curl -fsS http://localhost:8080/health >/dev/null
