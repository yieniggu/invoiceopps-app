import { describe, expect, it } from "vitest";

import {
  describeModelsFailure,
  describeReason,
  formatScore,
} from "./gateReasons";
import { ApiError } from "../auth/api/apiError";

// Every reason code of the Model API README must read as Spanish text.
const CODES = [
  "INVALID_REFERENCE",
  "MODEL_VERSION_NOT_FOUND",
  "ARTIFACT_SOURCE_NOT_ALLOWED",
  "ARTIFACT_LAYOUT_INVALID",
  "ARTIFACT_TOO_LARGE",
  "PICKLE_FORMAT_NOT_ALLOWED",
  "UNSUPPORTED_FLAVOR",
  "UNTRUSTED_TYPE",
  "SKOPS_ARCHIVE_INVALID",
  "MODEL_LOAD_FAILED",
  "MODEL_STRUCTURE_INVALID",
  "MODEL_CHECK_CRASHED",
  "MODEL_CHECK_TIMEOUT",
  "SIGNATURE_MISSING",
  "SIGNATURE_MISMATCH",
  "NO_PREDICT_PROBA",
  "INVALID_CLASSES",
  "INFERENCE_FAILED",
  "AUC_BELOW_MIN",
  "AUC_LIFT_BELOW_MIN",
  "CHECK_INTERRUPTED",
];

describe("gate reason messages", () => {
  it.each(CODES)(
    "%s has its own Spanish text, never the English message",
    (code) => {
      const text = describeReason({
        code,
        message: "English diagnostic that students must not see",
        detail: {},
      });
      expect(text).not.toContain("English diagnostic");
      expect(text).not.toContain("código");
      expect(text.length).toBeGreaterThan(10);
    },
  );

  it("fills the AUC numbers like the ticket asks", () => {
    expect(
      describeReason({
        code: "AUC_BELOW_MIN",
        message: "",
        detail: { auc: 0.61, minAuc: 0.7 },
      }),
    ).toBe("AUC 0,61 en validación oficial, mínimo 0,70");
    expect(
      describeReason({
        code: "AUC_LIFT_BELOW_MIN",
        message: "",
        detail: { auc: 0.71, dummyAuc: 0.5, lift: 0.21, minLift: 0.3 },
      }),
    ).toBe("AUC 0,71 no supera al modelo base (0,50) por al menos 0,30");
  });

  it("falls back to the code for an unknown reason and tolerates missing detail", () => {
    expect(
      describeReason({ code: "BRAND_NEW", message: "", detail: {} }),
    ).toContain("BRAND_NEW");
    expect(
      describeReason({ code: "AUC_BELOW_MIN", message: "", detail: {} }),
    ).toBe("AUC — en validación oficial, mínimo —");
    expect(formatScore(null)).toBe("—");
  });

  it("lists the untrusted types a model uses", () => {
    expect(
      describeReason({
        code: "UNTRUSTED_TYPE",
        message: "",
        detail: { types: ["os.system", "builtins.eval"] },
      }),
    ).toContain("os.system, builtins.eval");
  });

  it("explains failed requests without showing the server message", () => {
    const failure = (status: number, code?: string) =>
      describeModelsFailure(new ApiError(status, code, "server text"), "base");
    expect(failure(409, "DEPLOYMENT_LIMIT")).toBe("No hay cupo ahora.");
    expect(failure(429, "RATE_LIMITED")).toBe(
      "Demasiadas verificaciones. Espera un momento.",
    );
    expect(failure(409, "CONFLICT")).toBe("El despliegue cambió.");
    expect(failure(503, "SERVICE_UNAVAILABLE")).toBe(
      "Servicio de modelos no disponible.",
    );
    expect(failure(403, "FORBIDDEN")).toBe("Sin permiso para desplegar.");
    expect(failure(404, "NOT_FOUND")).toBe(
      "Sección o despliegue no disponible.",
    );
    expect(failure(400, "VALIDATION_ERROR")).toBe("base");
    expect(describeModelsFailure(new Error("x"), "base")).toBe("base");
  });

  it("shows how long to wait when the server says so (CR-574)", () => {
    const limited = new ApiError(429, "RATE_LIMITED", "x", undefined, 90);
    expect(describeModelsFailure(limited, "base")).toBe(
      "Demasiadas verificaciones. Espera 2 min.",
    );
  });

  it("tells a busy system (503 RETRYABLE_CONFLICT) from an unavailable service (CR-574)", () => {
    const busy = new ApiError(503, "RETRYABLE_CONFLICT", "x");
    const down = new ApiError(503, "SERVICE_UNAVAILABLE", "x");
    expect(describeModelsFailure(busy, "base")).toBe(
      "Sistema ocupado. Intenta en unos segundos.",
    );
    expect(describeModelsFailure(down, "base")).toBe(
      "Servicio de modelos no disponible.",
    );
    expect(describeModelsFailure(busy, "base")).not.toBe(
      describeModelsFailure(down, "base"),
    );
  });

  it("reads a gateway timeout and a non-JSON answer as «sin respuesta» (CR-553)", () => {
    const failure = (status: number, code?: string) =>
      describeModelsFailure(
        new ApiError(status, code, "Request failed"),
        "base",
      );
    expect(failure(504)).toBe("Sin respuesta del servicio.");
    expect(failure(504, "GATEWAY_TIMEOUT")).toBe("Sin respuesta del servicio.");
    expect(failure(502)).toBe("Sin respuesta del servicio.");
    expect(failure(524)).toBe("Sin respuesta del servicio.");
    // Cloudflare's 524 reads like 504 even when a body carries a code.
    expect(failure(524, "ORIGIN_TIMEOUT")).toBe("Sin respuesta del servicio.");
    // A JSON error with its own code is not a gateway failure.
    expect(failure(500, "INTERNAL_ERROR")).toBe("base");
  });
});
