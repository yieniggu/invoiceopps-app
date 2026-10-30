import request from "./support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { AuthError, type AuthService } from "../src/auth.js";
import type { InvoiceReadService } from "../src/features/invoices/services.js";

function createAuth(): AuthService {
  return {
    async login() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async getProfile(token) {
      if (token !== "valid-session") {
        throw new AuthError(401, "Unauthenticated");
      }

      return {
        id: "user-1",
        name: "Ada Lovelace",
        rut: "123456785",
        email: null,
        username: null,
        isPlatformAdministrator: false,
        memberships: [],
      };
    },
    async updateProfile() {
      throw new Error("not used");
    },
  };
}

describe("invoice detail route transport safety", () => {
  it("maps a malformed percent-escaped invoice id to 400 without logging or leaking", async () => {
    const getInvoice = vi.fn<InvoiceReadService["getInvoice"]>();
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoiceReads: { listInvoices: vi.fn(), getInvoice },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app)
        .get(
          "/api/v1/invoices/%E0%A4%A?organizationId=11111111-1111-4111-8111-111111111111",
        )
        .set("Cookie", "invoiceops_session=valid-session");
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: "BAD_REQUEST", message: "Bad request" },
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /URIError|at \w+|stack/,
      );
      expect(logged).not.toHaveBeenCalled();
      expect(getInvoice).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
