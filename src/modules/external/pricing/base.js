export class PricingProvider {
  id() { return "base"; }
  canHandle(q) { return false; }
  async price(partNumber) { throw new Error("not implemented"); }
}
