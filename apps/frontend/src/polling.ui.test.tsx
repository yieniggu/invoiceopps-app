import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInvoiceQuery } from "./features/invoices/hooks/useInvoice";
import { useDeployments } from "./features/models/hooks/useModels";
import { POLL_GIVE_UP_MS } from "./lib/boundedPolling";
import { norte } from "./test/invoices";
import { uuid } from "./test/ids";
import { invoice } from "./test/invoices";
import { jsonResponse, mockTransport } from "./test/transport";
import { renderWithIdentity } from "./test/renderWithIdentity";

// Polling is driven by fake timers: every assertion counts the requests that
// really went out, so a timer that outlives its screen or restarts on a
// re-render shows up as an extra call.

const found = invoice(5);
const INVOICE_ROUTE = `GET /api/v1/invoices/${found.id}`;
const DEPLOYMENTS_ROUTE = "GET /api/v1/deployments";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const pendingPrediction = {
  id: uuid(1),
  deploymentId: uuid(2),
  deploymentScope: "ORGANIZATION",
  registeredModel: "invoice-risk",
  modelVersion: "1",
  runId: null,
  probability: null,
  status: "PENDING",
  errorCode: null,
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:00.000Z",
};

/** Re-renders its children on demand, inside the same providers. */
function Rerender({ children }: { children: React.ReactNode }) {
  const [renders, setRenders] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setRenders(renders + 1)}>
        rerender {renders}
      </button>
      {children}
    </>
  );
}

function InvoiceProbe() {
  const { query, gaveUp, refresh } = useInvoiceQuery(
    norte.id,
    undefined,
    found.id,
    true,
  );
  return (
    <>
      <p data-testid="state">
        {gaveUp ? "gave-up" : query.data ? "ready" : "loading"}
      </p>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </>
  );
}

describe("invoice detail polling (CR-551)", () => {
  it("polls a bounded number of times, survives re-renders and stops on its own", async () => {
    const transport = mockTransport({
      [INVOICE_ROUTE]: () =>
        jsonResponse({ invoice: found, predictions: [pendingPrediction] }),
    });
    renderWithIdentity(
      <Rerender>
        <InvoiceProbe />
      </Rerender>,
    );
    await advance(0);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(1);

    await advance(2_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(2);

    // A forced re-render must not restart or duplicate the timer.
    fireEvent.click(screen.getByRole("button", { name: /^rerender/ }));
    await advance(1_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(2);
    await advance(1_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(3);

    await advance(POLL_GIVE_UP_MS + 20_000);
    const total = transport.calls(INVOICE_ROUTE).length;
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(25);
    expect(screen.getByTestId("state").textContent).toBe("gave-up");

    await advance(10 * 60_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(total);
  });

  it("stops polling as soon as nothing is pending", async () => {
    let reads = 0;
    const transport = mockTransport({
      [INVOICE_ROUTE]: () => {
        reads += 1;
        return jsonResponse({
          invoice: found,
          predictions: reads < 3 ? [pendingPrediction] : [],
        });
      },
    });
    renderWithIdentity(<InvoiceProbe />);
    await advance(30_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(3);
    expect(screen.getByTestId("state").textContent).toBe("ready");
  });

  it("stops polling when the screen unmounts", async () => {
    const transport = mockTransport({
      [INVOICE_ROUTE]: () =>
        jsonResponse({ invoice: found, predictions: [pendingPrediction] }),
    });
    const view = renderWithIdentity(<InvoiceProbe />);
    await advance(2_000);
    const before = transport.calls(INVOICE_ROUTE).length;
    view.unmount();
    await advance(5 * 60_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(before);
  });

  it("starts a new bounded run when the person refreshes after it gave up", async () => {
    const transport = mockTransport({
      [INVOICE_ROUTE]: () =>
        jsonResponse({ invoice: found, predictions: [pendingPrediction] }),
    });
    renderWithIdentity(<InvoiceProbe />);
    await advance(POLL_GIVE_UP_MS + 20_000);
    expect(screen.getByTestId("state").textContent).toBe("gave-up");
    const afterFirstRun = transport.calls(INVOICE_ROUTE).length;

    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await advance(0);
    expect(transport.calls(INVOICE_ROUTE).length).toBe(afterFirstRun + 1);
    // The run restarted: not given up any more, polling again.
    expect(screen.getByTestId("state").textContent).toBe("ready");
    await advance(5_000);
    expect(transport.calls(INVOICE_ROUTE).length).toBeGreaterThan(
      afterFirstRun + 1,
    );
  });
});

describe("polling that fails or starts from old cache (CR-575, CR-578)", () => {
  it("stops polling on errors, offers the refresh and keeps the calls bounded (CR-575)", async () => {
    let reads = 0;
    const transport = mockTransport({
      [INVOICE_ROUTE]: () => {
        reads += 1;
        return reads === 1
          ? jsonResponse({ invoice: found, predictions: [pendingPrediction] })
          : new Response("{}", { status: 500 });
      },
    });
    renderWithIdentity(<InvoiceProbe />);
    await advance(0);
    expect(screen.getByTestId("state").textContent).toBe("ready");
    await advance(2_100);
    // The second read failed: the run is over and the refresh is offered.
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(2);
    expect(screen.getByTestId("state").textContent).toBe("gave-up");
    await advance(10 * 60_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(2);
  });

  it("stops polling the deployments on errors too (CR-575)", async () => {
    let reads = 0;
    const transport = mockTransport({
      [DEPLOYMENTS_ROUTE]: () => {
        reads += 1;
        return reads === 1
          ? jsonResponse(deploymentList("CHECKING"))
          : new Response("{}", { status: 500 });
      },
    });
    renderWithIdentity(<DeploymentsProbe />);
    await advance(2_100);
    expect(screen.getByTestId("state").textContent).toBe("stalled");
    await advance(10 * 60_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(2);
  });

  it("does not give up at once on cached data that is minutes old (CR-578)", async () => {
    const transport = mockTransport({
      [INVOICE_ROUTE]: () =>
        jsonResponse({ invoice: found, predictions: [pendingPrediction] }),
    });
    function Toggled() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(!shown)}>
            toggle
          </button>
          {shown ? <InvoiceProbe /> : null}
        </>
      );
    }
    renderWithIdentity(<Toggled />);
    await advance(0);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await advance(3 * 60_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(1);

    // The cache holds a PENDING read from three minutes ago.
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await advance(0);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(2);
    expect(screen.getByTestId("state").textContent).toBe("ready");
    await advance(2_000);
    expect(transport.calls(INVOICE_ROUTE)).toHaveLength(3);
    expect(screen.getByTestId("state").textContent).toBe("ready");
  });
});

const checking = (status: "CHECKING" | "ACTIVE") => ({
  id: uuid(700),
  organizationId: norte.id,
  groupId: null,
  workspace: "org",
  registeredModel: "invoice-risk",
  version: "1",
  runId: null,
  status,
  inferenceEnabled: false,
  loaded: true,
  gate: null,
  createdByUserId: "u",
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:00.000Z",
});

const deploymentList = (status: "CHECKING" | "ACTIVE") => ({
  items: [checking(status)],
  limits: { activeCount: 1, maxActive: 3, maxChecksPerHour: 10 },
  modelApiAvailable: true,
});

function DeploymentsProbe() {
  const { query, stalled, refresh } = useDeployments({
    organizationId: norte.id,
    groupId: null,
  });
  return (
    <>
      <p data-testid="state">
        {stalled ? "stalled" : query.data ? "ready" : "loading"}
      </p>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </>
  );
}

describe("deployments polling (CR-554)", () => {
  it("polls while a deployment is CHECKING, stops when it settles", async () => {
    let reads = 0;
    const transport = mockTransport({
      [DEPLOYMENTS_ROUTE]: () => {
        reads += 1;
        return jsonResponse(deploymentList(reads < 3 ? "CHECKING" : "ACTIVE"));
      },
    });
    renderWithIdentity(<DeploymentsProbe />);
    await advance(0);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(1);
    await advance(2_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(2);
    await advance(2_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(3);
    await advance(60_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(3);
    expect(screen.getByTestId("state").textContent).toBe("ready");
  });

  it("does not poll a list without CHECKING rows", async () => {
    const transport = mockTransport({
      [DEPLOYMENTS_ROUTE]: () => jsonResponse(deploymentList("ACTIVE")),
    });
    renderWithIdentity(<DeploymentsProbe />);
    await advance(60_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(1);
  });

  it("gives up after about two minutes, survives re-renders and stops on unmount", async () => {
    const transport = mockTransport({
      [DEPLOYMENTS_ROUTE]: () => jsonResponse(deploymentList("CHECKING")),
    });
    const view = renderWithIdentity(
      <Rerender>
        <DeploymentsProbe />
      </Rerender>,
    );
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: /^rerender/ }));
    await advance(1_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(1);
    await advance(POLL_GIVE_UP_MS + 20_000);
    const total = transport.calls(DEPLOYMENTS_ROUTE).length;
    expect(total).toBeLessThan(25);
    expect(screen.getByTestId("state").textContent).toBe("stalled");
    await advance(5 * 60_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(total);
    view.unmount();
    await advance(5 * 60_000);
    expect(transport.calls(DEPLOYMENTS_ROUTE)).toHaveLength(total);
  });
});
