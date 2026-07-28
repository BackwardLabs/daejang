FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY services/engine/go.mod services/engine/go.sum ./services/engine/
WORKDIR /src/services/engine
RUN --mount=type=secret,id=github_token,required=true \
    token="$(cat /run/secrets/github_token)" \
    && printf 'machine github.com\nlogin x-access-token\npassword %s\n' "$token" > /root/.netrc \
    && chmod 0600 /root/.netrc \
    && GOPRIVATE=github.com/BackwardLabs/* go mod download \
    && rm -f /root/.netrc
COPY services/engine /src/services/engine
WORKDIR /src/services/engine
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/engine-api ./cmd/engine-api \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/sync-worker ./cmd/sync-worker \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/engine-healthcheck ./cmd/engine-healthcheck \
 && mkdir -p /out/review-artifacts/objects /out/review-artifacts/tmp

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=build /out/engine-api /usr/local/bin/engine-api
COPY --from=build /out/sync-worker /usr/local/bin/sync-worker
COPY --from=build /out/engine-healthcheck /usr/local/bin/engine-healthcheck
COPY --from=build --chown=65532:65532 /out/review-artifacts /var/lib/daejang/review-artifacts
EXPOSE 50051
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/engine-api"]
