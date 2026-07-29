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
 && mkdir -p /out/review-artifacts/objects /out/review-artifacts/tmp \
    /out/source-artifacts/objects /out/source-artifacts/tmp /out/pdf-parser-socket

FROM python:3.13-slim-bookworm AS parser-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY services/engine/python/requirements.lock.txt /tmp/requirements.lock.txt
RUN --mount=type=secret,id=github_token,required=true \
    token="$(cat /run/secrets/github_token)" \
    && printf 'machine github.com\nlogin x-access-token\npassword %s\n' "$token" > /root/.netrc \
    && chmod 0600 /root/.netrc \
    && python -m venv /opt/daejang-pdf-parser \
    && /opt/daejang-pdf-parser/bin/pip install --no-cache-dir -r /tmp/requirements.lock.txt \
    && rm -f /root/.netrc

FROM python:3.13-slim-bookworm AS parser-runtime
RUN groupadd --gid 65532 nonroot \
 && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin nonroot \
 && install -d -o 65532 -g 65532 -m 0700 /run/daejang/pdf-parser
COPY --from=parser-deps /opt/daejang-pdf-parser /opt/daejang-pdf-parser
COPY services/engine/python/pdf_parser_server.py /opt/daejang-engine/python/pdf_parser_server.py
USER nonroot:nonroot
ENTRYPOINT ["/opt/daejang-pdf-parser/bin/python", "-I", "-B", "/opt/daejang-engine/python/pdf_parser_server.py"]
CMD ["--socket", "/run/daejang/pdf-parser/parser.sock", "--request-timeout-seconds", "25"]

FROM gcr.io/distroless/static-debian12:nonroot AS engine-runtime
COPY --from=build /out/engine-api /usr/local/bin/engine-api
COPY --from=build /out/sync-worker /usr/local/bin/sync-worker
COPY --from=build /out/engine-healthcheck /usr/local/bin/engine-healthcheck
COPY --from=build --chown=65532:65532 /out/review-artifacts /var/lib/daejang/review-artifacts
COPY --from=build --chown=65532:65532 /out/source-artifacts /var/lib/daejang/source-artifacts
COPY --from=build --chown=65532:65532 /out/pdf-parser-socket /run/daejang/pdf-parser
EXPOSE 50051
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/engine-api"]
