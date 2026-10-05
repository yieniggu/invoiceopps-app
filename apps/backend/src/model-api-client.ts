export type ModelApiInvoice = {
  invoiceAmountCents: number;
  hasPurchaseOrder: boolean;
  threeWayMatch: boolean;
  vendorTenureDays: number;
  previousIncidents12m: number;
  bankAccountRecentlyChanged: boolean;
  amountVsVendorMedian: number;
  countryRisk: string;
};

export type ModelPrediction = {
  modelId: string;
  modelVersion: string;
  runId: string;
  probability: number;
};

export interface ModelApiClient {
  predict(invoice: ModelApiInvoice): Promise<ModelPrediction>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function isPrediction(value: unknown): value is {
  model_id: string;
  model_version: string;
  run_id: string;
  probability: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.model_id === "string" &&
    Boolean(response.model_id) &&
    typeof response.model_version === "string" &&
    Boolean(response.model_version) &&
    typeof response.run_id === "string" &&
    Boolean(response.run_id) &&
    typeof response.probability === "number" &&
    Number.isFinite(response.probability) &&
    response.probability >= 0 &&
    response.probability <= 1
  );
}

export function createModelApiClient({
  baseUrl,
  modelId,
  fetch = globalThis.fetch,
  timeoutMs = 2_000,
}: {
  baseUrl: string;
  modelId: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): ModelApiClient {
  const endpointUrl = new URL(baseUrl);
  endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/?$/, "/")}models/${encodeURIComponent(modelId)}/predict`;
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const endpoint = endpointUrl.toString();

  return {
    async predict(invoice) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          invoice_amount_cents: invoice.invoiceAmountCents,
          has_purchase_order: invoice.hasPurchaseOrder,
          three_way_match: invoice.threeWayMatch,
          vendor_tenure_days: invoice.vendorTenureDays,
          previous_incidents_12m: invoice.previousIncidents12m,
          bank_account_recently_changed: invoice.bankAccountRecentlyChanged,
          amount_vs_vendor_median: invoice.amountVsVendorMedian,
          country_risk: invoice.countryRisk,
        }),
      });
      if (!response.ok) throw new Error("Model API request failed");

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Model API response was invalid");
      }
      if (!isPrediction(payload) || payload.model_id !== modelId)
        throw new Error("Model API response was invalid");

      return {
        modelId: payload.model_id,
        modelVersion: payload.model_version,
        runId: payload.run_id,
        probability: payload.probability,
      };
    },
  };
}
