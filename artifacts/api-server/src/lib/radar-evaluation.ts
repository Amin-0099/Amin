import { desc, eq, inArray } from "drizzle-orm";
import type { AssetCode, FinalReport } from "@workspace/api-zod";
import {
  db,
  radarSignalOutcomes,
  radarSignals,
} from "@workspace/db";
import type { MarketSnapshot } from "./market-data";

type RadarObservation = {
  asset: AssetCode;
  report: FinalReport;
  snapshot: MarketSnapshot;
};

const evaluationHorizons = [1, 24, 168] as const;

export async function recordAndEvaluateRadarSignals(
  observations: RadarObservation[],
): Promise<void> {
  const symbols = observations.map((item) => item.asset);
  const snapshots = new Map(observations.map((item) => [item.asset, item.snapshot]));
  const signalsToInsert = observations.map(({ asset, report, snapshot }) => {
    const latestCandle = snapshot.hourlyCandles.at(-1);
    const observedAt = latestCandle
      ? new Date(latestCandle.closeTime)
      : new Date(report.generatedAt);
    return {
      signalKey: latestCandle
        ? `${asset}:${observedAt.toISOString()}:${report.decision}`
        : `${asset}:missing:${report.generatedAt.slice(0, 10)}:${report.decision}`,
      asset,
      signalType: report.decision,
      stance: report.stance,
      observedAt,
      referencePriceUsdt: latestCandle?.close.toFixed(10) ?? null,
      dataStatus: report.dataStatus,
      snapshot: {
        generatedAt: report.generatedAt,
        observedAt: observedAt.toISOString(),
        referencePriceSource: latestCandle ? snapshot.hourlyStatus.source : null,
        referencePriceUsdt: latestCandle?.close ?? null,
        marketDataStatus: report.dataStatus,
        sourceStatuses: snapshot.sourceStatuses,
        evidence: report.evidence,
        counterArguments: report.counterArguments,
        currentData: report.currentData,
        decision: report.decision,
        stance: report.stance,
        radarState: report.radarState,
        confidenceBreakdown: report.confidenceBreakdown,
      },
    };
  });
  if (signalsToInsert.length) {
    await db.insert(radarSignals).values(signalsToInsert).onConflictDoNothing();
  }

  const recentSignals = await db
    .select()
    .from(radarSignals)
    .where(inArray(radarSignals.asset, symbols))
    .orderBy(desc(radarSignals.observedAt))
    .limit(2_000);
  if (!recentSignals.length) return;
  const signalIds = recentSignals.map((signal) => signal.id);
  const existingOutcomes = await db
    .select({
      signalId: radarSignalOutcomes.signalId,
      horizonHours: radarSignalOutcomes.horizonHours,
    })
    .from(radarSignalOutcomes)
    .where(inArray(radarSignalOutcomes.signalId, signalIds));
  const existingKeys = new Set(
    existingOutcomes.map((outcome) => `${outcome.signalId}:${outcome.horizonHours}`),
  );
  const outcomes = recentSignals.flatMap((signal) => {
    const snapshot = snapshots.get(signal.asset as AssetCode);
    const reference = Number(signal.referencePriceUsdt);
    if (
      !snapshot ||
      signal.dataStatus !== "live" ||
      !Number.isFinite(reference) ||
      reference <= 0 ||
      signal.stance === "not_evaluable"
    ) {
      return [];
    }
    return evaluationHorizons.flatMap((horizonHours) => {
      if (existingKeys.has(`${signal.id}:${horizonHours}`)) return [];
      const outcomeStatus = horizonHours === 168
        ? snapshot.dailyStatus.status
        : snapshot.hourlyStatus.status;
      if (outcomeStatus !== "live") return [];
      const target = signal.observedAt.getTime() + horizonHours * 60 * 60 * 1_000;
      const candles = horizonHours === 168 ? snapshot.dailyCandles : snapshot.hourlyCandles;
      const outcomeCandle = candles.find((candle) => candle.closeTime >= target);
      if (!outcomeCandle) return [];
      const returnPercent = ((outcomeCandle.close - reference) / reference) * 100;
      return [{
        signalId: signal.id,
        horizonHours,
        evaluatedAt: new Date(outcomeCandle.closeTime),
        outcomePriceUsdt: outcomeCandle.close.toFixed(10),
        returnPercent: returnPercent.toFixed(6),
        directionCorrect:
          signal.stance === "bullish"
            ? returnPercent > 0
            : signal.stance === "bearish"
              ? returnPercent < 0
              : null,
        source: horizonHours === 168
          ? snapshot.dailyStatus.source
          : snapshot.hourlyStatus.source,
      }];
    });
  });
  if (outcomes.length) {
    await db.insert(radarSignalOutcomes).values(outcomes).onConflictDoNothing();
  }
}

export type RadarPerformanceRow = {
  asset: string;
  signalType: string;
  stance: string;
  horizonHours: number;
  returnPercent: number;
  directionCorrect: boolean | null;
};

export type RadarErrorSourceCategory =
  | "missing_data"
  | "stale_data"
  | "source_disagreement"
  | "verification_mismatch"
  | "signal_conflict";

export function calculateRadarErrorSources(
  snapshots: Array<Record<string, unknown>>,
): Array<{ category: RadarErrorSourceCategory; signalCount: number }> {
  const counts = new Map<RadarErrorSourceCategory, number>();
  const increment = (category: RadarErrorSourceCategory) =>
    counts.set(category, (counts.get(category) ?? 0) + 1);
  for (const snapshot of snapshots) {
    const currentData = snapshot.currentData;
    const sourceStatuses =
      currentData && typeof currentData === "object" && "sourceStatuses" in currentData &&
      Array.isArray(currentData.sourceStatuses)
        ? currentData.sourceStatuses
        : [];
    if (sourceStatuses.some((source) =>
      source && typeof source === "object" && "status" in source && source.status === "missing",
    )) increment("missing_data");
    if (sourceStatuses.some((source) =>
      source && typeof source === "object" && "status" in source && source.status === "stale",
    )) increment("stale_data");
    if (
      currentData &&
      typeof currentData === "object" &&
      "sourceDeviationPercent" in currentData &&
      typeof currentData.sourceDeviationPercent === "number" &&
      currentData.sourceDeviationPercent > 1
    ) increment("source_disagreement");
    const counterArguments = Array.isArray(snapshot.counterArguments)
      ? snapshot.counterArguments.filter((item): item is string => typeof item === "string")
      : [];
    if (counterArguments.some((item) =>
      /Rohdaten-Snapshot|Zeitstempel|nicht mechanisch prüfbar/i.test(item),
    )) increment("verification_mismatch");
    const breakdown = snapshot.confidenceBreakdown;
    if (
      breakdown &&
      typeof breakdown === "object" &&
      "contradictionCount" in breakdown &&
      typeof breakdown.contradictionCount === "number" &&
      breakdown.contradictionCount > 0
    ) increment("signal_conflict");
  }
  return [...counts.entries()]
    .map(([category, signalCount]) => ({ category, signalCount }))
    .sort((left, right) => left.category.localeCompare(right.category));
}

export function calculateRadarPerformance(rows: RadarPerformanceRow[]) {
  const groups = new Map<string, {
    asset: string;
    signalType: string;
    stance: string;
    horizonHours: number;
    returns: number[];
    directionalResults: boolean[];
  }>();
  for (const row of rows) {
    const key = `${row.asset}:${row.signalType}:${row.stance}:${row.horizonHours}`;
    const group = groups.get(key) ?? {
      asset: row.asset,
      signalType: row.signalType,
      stance: row.stance,
      horizonHours: row.horizonHours,
      returns: [],
      directionalResults: [],
    };
    group.returns.push(row.returnPercent);
    if (row.directionCorrect !== null) group.directionalResults.push(row.directionCorrect);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      asset: group.asset,
      signalType: group.signalType,
      stance: group.stance,
      horizonHours: group.horizonHours,
      sampleCount: group.returns.length,
      directionalSampleCount: group.directionalResults.length,
      hits: group.directionalResults.filter(Boolean).length,
      hitRatePercent: group.directionalResults.length
        ? Math.round(
            (group.directionalResults.filter(Boolean).length / group.directionalResults.length) * 1000,
          ) / 10
        : null,
      averageReturnPercent:
        Math.round(
          (group.returns.reduce((sum, value) => sum + value, 0) / group.returns.length) * 1000,
        ) / 1000,
    }))
    .sort((left, right) =>
      left.asset.localeCompare(right.asset) ||
      left.signalType.localeCompare(right.signalType) ||
      left.horizonHours - right.horizonHours,
    );
}

export async function getRadarPerformance() {
  const rows = await db
    .select({
      asset: radarSignals.asset,
      signalType: radarSignals.signalType,
      stance: radarSignals.stance,
      horizonHours: radarSignalOutcomes.horizonHours,
      returnPercent: radarSignalOutcomes.returnPercent,
      directionCorrect: radarSignalOutcomes.directionCorrect,
    })
    .from(radarSignalOutcomes)
    .innerJoin(radarSignals, eq(radarSignalOutcomes.signalId, radarSignals.id));
  const signalSnapshots = await db
    .select({ snapshot: radarSignals.snapshot })
    .from(radarSignals)
    .orderBy(desc(radarSignals.observedAt))
    .limit(10_000);
  return {
    performance: calculateRadarPerformance(rows.map((row) => ({
    ...row,
    returnPercent: Number(row.returnPercent),
    }))),
    errorSources: calculateRadarErrorSources(signalSnapshots.map((row) => row.snapshot)),
  };
}
