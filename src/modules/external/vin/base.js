/**
 * Контракт VIN-провайдера:
 * - id(): string
 * - canHandle(q: string): boolean
 * - async fetchInfo(vin: string): Promise<{ parts: Array, meta: any }>
 */
export class VinProvider {
  id() { return "base"; }
  canHandle(_q) { return false; }
  async fetchInfo(_vin) { throw new Error("not implemented"); }
}
