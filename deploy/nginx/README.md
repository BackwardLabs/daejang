# Web API ingress

`web-api.conf`는 Web API 앞단에서 적용하는 최소 NGINX ingress 기준이다. TLS 8443에서만 요청을 받고 일반 API와 로그인 공급자별 경로에 서로 다른 IP 기반 제한을 적용하며, 제한 초과 응답은 `429`로 통일한다. 배포 플랫폼에서는 외부 443을 이 listener에 연결한다.

운영 조건:

- Web API 컨테이너는 외부에 직접 노출하지 않고 ingress만 공개한다.
- 별도 컨테이너 구성에서는 Web API에 `HOST=0.0.0.0`을 설정하되 port를 host/public network에 publish하지 않고 ingress와 공유하는 internal network에만 연결한다. 같은 process/network namespace라면 loopback bind를 유지한다.
- 공개 인증서와 private key를 각각 `/run/secrets/public-tls-cert.pem`, `/run/secrets/public-tls-key.pem`에 read-only secret으로 mount한다.
- NGINX와 Web API 사이가 한 홉이면 Web API의 `TRUST_PROXY_HOPS=1`을 사용한다.
- 다른 프록시나 CDN을 추가하면 신뢰할 프록시 CIDR과 실제 클라이언트 IP 헤더를 배포 환경에서 명시한다. 임의의 `X-Forwarded-For`를 신뢰하지 않는다.
- 앱 내부의 PostgreSQL 로그인 제한은 ingress 제한을 우회한 요청과 여러 인스턴스 간 누적 시도를 추가로 차단한다.
- 실제 로그인 경로가 추가되면 `/api/v1/auth/{siwe|oidc|email}/` 접두사를 유지하거나 이 설정도 함께 변경한다.

구문 확인:

```bash
docker run --rm \
  -v "$PWD/deploy/nginx/web-api.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/deploy/nginx/proxy_params:/etc/nginx/proxy_params:ro" \
  -v "/path/to/test-cert.pem:/run/secrets/public-tls-cert.pem:ro" \
  -v "/path/to/test-key.pem:/run/secrets/public-tls-key.pem:ro" \
  nginx:1.29-alpine nginx -t
```
