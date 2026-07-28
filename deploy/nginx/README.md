# Web API ingress

`web-api.conf`는 Web API 앞단에서 적용하는 최소 NGINX ingress 기준이다. TLS 8443에서만 요청을 받고 일반 API와 로그인 공급자별 경로에 서로 다른 IP 기반 제한을 적용하며, 제한 초과 응답은 `429`로 통일한다. 배포 플랫폼에서는 외부 443을 이 listener에 연결한다.

운영 조건:

- Web API 컨테이너는 외부에 직접 노출하지 않고 ingress만 공개한다.
- 별도 컨테이너 구성에서는 Web API에 `HOST=0.0.0.0`을 설정하되 port를 host/public network에 publish하지 않고 ingress와 공유하는 internal network에만 연결한다. 같은 process/network namespace라면 loopback bind를 유지한다.
- 공개 인증서와 private key를 각각 `/run/secrets/public-tls-cert.pem`, `/run/secrets/public-tls-key.pem`에 read-only secret으로 mount한다.
- NGINX와 Web API 사이가 한 홉이면 Web API의 `TRUST_PROXY_HOPS=1`을 사용한다.
- 다른 프록시나 CDN을 추가하면 신뢰할 프록시 CIDR과 실제 클라이언트 IP 헤더를 배포 환경에서 명시한다. 임의의 `X-Forwarded-For`를 신뢰하지 않는다.
- 앱 내부의 PostgreSQL 로그인 제한은 ingress 제한을 우회한 요청과 여러 인스턴스 간 누적 시도를 추가로 차단한다.
- 실제 로그인 경로는 `/api/v1/auth/{siwe|oauth|email}/` 접두사를 사용한다. 구글·카카오 OIDC와 네이버 OAuth는 공통 `/oauth/` 제한에 포함한다.

## Cloudflare Worker와 API origin

운영 도메인의 `/api/*` 요청은 `apps/edge` Worker가 먼저 받고,
`WEB_API_ORIGIN`으로 지정한 별도 HTTPS origin에 전달한다. Worker는 이때
Cloudflare Access service token header를 추가한다. 같은 Worker가 나머지
경로에서는 `apps/web/dist`의 SPA를 제공한다. 공개 도메인 자체를
`WEB_API_ORIGIN`으로 다시 지정하면 순환 요청이 되므로 사용할 수 없다.

API origin은 Tunnel 또는 별도 hostname으로 이 NGINX ingress에 연결하고,
Cloudflare Access service-token policy로 보호한다. Worker에는 다음 세 값을
secret으로 등록한다.

```bash
npx wrangler secret put WEB_API_ORIGIN
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

컨테이너 기준 설정은 `deploy/compose.production.yaml`과
`deploy/production.env.example`에 있다. DB Compose를 먼저 띄워
`daejang-db_default` network를 만든 뒤 Web API·Engine이 그 private network에
참가한다. PostgreSQL port를 외부에 공개해 두 Compose를 연결하지 않는다.
Engine과 Web API는 host port를 직접 publish하지 않으며 NGINX만 공개한다.
PDF content 경로만 20 MiB를 허용하고 다른 API 요청은 1 MiB 제한을 유지한다.

배포 뒤 공개 경로가 SPA로 빠지지 않는지 확인한다.

```bash
curl -i https://daejang.backwardlabs.io/api/v1/me
curl -i \
  'https://daejang.backwardlabs.io/api/v1/auth/oauth/naver/start?intent=login'
```

첫 요청은 HTML이 아닌 JSON `401`과 `Cache-Control: no-store`를 반환해야 한다.
두 번째 요청은 `nid.naver.com`으로 향하는 `302`와
`HttpOnly; Secure; SameSite=Lax` OAuth 거래 cookie를 반환해야 한다.

구문 확인:

```bash
NGINX_TEST_DIR="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$NGINX_TEST_DIR/test-key.pem" \
  -out "$NGINX_TEST_DIR/test-cert.pem" \
  -days 1 \
  -subj "/CN=localhost"

docker run --rm \
  --add-host web-api:127.0.0.1 \
  -v "$PWD/deploy/nginx/web-api.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/deploy/nginx/proxy_params:/etc/nginx/proxy_params:ro" \
  -v "$NGINX_TEST_DIR/test-cert.pem:/run/secrets/public-tls-cert.pem:ro" \
  -v "$NGINX_TEST_DIR/test-key.pem:/run/secrets/public-tls-key.pem:ro" \
  nginx:1.29-alpine nginx -t

rm -rf "$NGINX_TEST_DIR"
```

`--add-host`는 구문만 검사하는 standalone 컨테이너에서도 `web-api` upstream 이름을 해석할 수 있게 한다. 실제 Compose 배포에서는 같은 이름의 서비스가 내부 DNS를 제공한다.
