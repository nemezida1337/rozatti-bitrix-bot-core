export class PricingProvider {
  id() { return "base"; }
  canHandle(_q) { return false; }
  async price(_partNumber) { throw new Error("not implemented"); }
}
