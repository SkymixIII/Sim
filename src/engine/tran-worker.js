// Analyse transitoire hors du fil principal : l'interface reste réactive.
import { runTransientJob } from "./circuit.js";

self.onmessage = (e) => {
  const { id, circuit, opts } = e.data;
  try {
    const out = runTransientJob(circuit, opts);
    self.postMessage({ id, ...out.message }, out.transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
