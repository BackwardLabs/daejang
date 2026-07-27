export class EngineRpcError extends Error {
  constructor(readonly grpcCode: number) {
    super('Engine RPC request failed')
    this.name = 'EngineRpcError'
  }
}
