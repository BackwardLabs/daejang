# JIT gRPC contract pin

이 디렉터리의 `jit.proto`, `jit.pb.go`, `jit_grpc.pb.go`는
`BackwardLabs/daejang-jit-engine`의 다음 공개 커밋에서 그대로 복사한 client
contract입니다.

- commit: `e92bc3cd914f997b06ef073cfdf0463b899446f5`
- source: `api/giwa/jit/v1/jit.proto`
- generated package: `gen/go/giwa/jit/v1`

Engine worker가 JIT engine 전체 Go module과 persistence/provider 의존성을 끌어오지
않으면서도 배포된 `jitd`의 정확한 wire contract를 사용하도록 client contract만
고정합니다. JIT RPC가 바뀔 때는 위 세 파일을 같은 커밋에서 한 번에 갱신하고
adapter 통합 테스트를 다시 실행해야 합니다.
