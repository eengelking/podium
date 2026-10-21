import { IconCertCross, IconClock, IconWarn } from "../components/Icons";
import { stageOf, statusText, type CertStage } from "./certFormat";

const ICON = { soon: IconClock, serious: IconWarn, critical: IconWarn, expired: IconCertCross };
const TONE = { soon: "soon", serious: "serious", critical: "bad", expired: "bad" } as const;

/** A certificate's status as a badge: blue clock, orange and red triangle, ring and cross, or a dot for a valid one. Shape, word and color. */
export function CertBadge({ notAfter, now, stage = stageOf(notAfter, now), text = statusText(notAfter, now) }: { notAfter: string; now: number; stage?: CertStage; text?: string }) {
  if (stage === "ok") {
    return (
      <span className="badge ok">
        <span className="dot running" aria-hidden="true" />
        {text}
      </span>
    );
  }
  const Icon = ICON[stage];
  return (
    <span className={`badge ${TONE[stage]}`}>
      <Icon />
      {text}
    </span>
  );
}
