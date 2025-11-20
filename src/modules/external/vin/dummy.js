import { VinProvider } from "./base.js";
export class DummyVin extends VinProvider {
  id() { return "dummy-vin"; }
  canHandle(q) { return /^vin\s+/i.test(q); }
  async fetchInfo(vin) { return { parts: [], meta: { vin, demo: true } }; }
}
