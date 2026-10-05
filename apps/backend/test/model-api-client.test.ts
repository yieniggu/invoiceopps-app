import { describe, expect, it, vi } from "vitest";

import { createModelApiClient } from "../src/model-api-client.js";

const invoice = {
  invoiceAmountCents: 420_000,
  hasPurchaseOrder: true,
  threeWayMatch: false,
  vendorTenureDays: 365,
  previousIncidents12m: 2,
  bankAccountRecentlyChanged: true,
  amountVsVendorMedian: 1.25,
  countryRisk: "high",
};

describe("Model API client", () => {
  it("maps exactly the eight invoice features and returns validated metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model_id: "invoice-review",
          model_version: "12",
          run_id: "run-123",
          probability: 0.8,
        }),
        { status: 200 },
      ),
    );
    const client = createModelApiClient({
      baseUrl: "http://model-api.test",
      modelId: "invoice-review",
      fetch,
      timeoutMs: 500,
    });

    await expect(client.predict(invoice)).resolves.toEqual({
      modelId: "invoice-review",
      modelVersion: "12",
      runId: "run-123",
      probability: 0.8,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://model-api.test/models/invoice-review/predict",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          invoice_amount_cents: 420_000,
          has_purchase_order: true,
          three_way_match: false,
          vendor_tenure_days: 365,
          previous_incidents_12m: 2,
          bank_account_recently_changed: true,
          amount_vs_vendor_median: 1.25,
          country_risk: "high",
        }),
      }),
    );
  });

  it("preserves the base path and encodes the model ID as one path segment", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model_id: "invoice/review",
          model_version: "12",
          run_id: "run-123",
          probability: 0.8,
        }),
        { status: 200 },
      ),
    );
    const client = createModelApiClient({
      baseUrl: "http://model-api.test/model-api",
      modelId: "invoice/review",
      fetch,
    });

    await client.predict(invoice);

    expect(fetch).toHaveBeenCalledWith(
      "http://model-api.test/model-api/models/invoice%2Freview/predict",
      expect.anything(),
    );
  });

  it("rejects a valid response belonging to another model", async () => {
    const client = createModelApiClient({
      baseUrl: "http://model-api.test",
      modelId: "invoice-review",
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model_id: "other-model",
            model_version: "12",
            run_id: "run-123",
            probability: 0.8,
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(client.predict(invoice)).rejects.toThrow("Model API");
  });

  it.each([
    [new Response(null, { status: 503 })],
    [new Response("not json", { status: 200 })],
    [
      new Response(
        JSON.stringify({
          model_id: "invoice-review",
          model_version: "12",
          run_id: "run-123",
          probability: 1.1,
        }),
        { status: 200 },
      ),
    ],
  ])("rejects an unsafe provider response", async (response) => {
    const client = createModelApiClient({
      baseUrl: "http://model-api.test",
      modelId: "invoice-review",
      fetch: vi.fn().mockResolvedValue(response),
    });

    await expect(client.predict(invoice)).rejects.toThrow("Model API");
  });

  it("aborts an unresponsive provider request with the configured timeout", async () => {
    const fetch = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    const client = createModelApiClient({
      baseUrl: "http://model-api.test",
      modelId: "configured-model",
      fetch,
      timeoutMs: 1,
    });

    await expect(client.predict(invoice)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://model-api.test/models/configured-model/predict",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
