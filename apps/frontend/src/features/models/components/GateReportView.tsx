import { describeMetrics, describeReason } from "../gateReasons";
import type { GateReport } from "../types";

/** Result of one gate run: what was measured and, when rejected, why. */
export function GateReportView({ gate }: { gate: GateReport }) {
  const metrics = describeMetrics(gate);
  return (
    <div className="gate-report">
      {metrics ? <p className="muted">{metrics}</p> : null}
      {gate.reasons.length > 0 ? (
        <ul>
          {gate.reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>{describeReason(reason)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
