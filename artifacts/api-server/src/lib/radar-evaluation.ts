import { desc, eq, inArray } from "drizzle-orm";
import type { AssetCode, FinalReport } from "@workspace/api-zod";
import {
  db,
  radarSignalOutcomes,
  radarSignals,
} from "@workspace/db";
import type { Candle, MarketSnapshot } from "./market-data";

type RadarObservation = {
  asset: AssetCode;
  report: FinalReport;
  snapshot: MarketSnapshot;
};

const evaluationHorizons = [1, 24, 168] as const;

export function copySignalSnapshot<T extends Record<string, unknown>>(snapshot: T): T {
  return structuredClone(snapshot);
}

export type SignalEvaluationResult = {
  horizonHours: number;
  evaluatedAt: Date | null;
  outcomePriceUsdt: number | null;
  returnPercent: number | null;
  directionCorrect: boolean | null;
  evaluationStatus: "open" | "successful" | "failed" | "insufficient_data";
  evaluationReason: string;
  invalidationPriceUsdt: number | null;
  maxFavorableReturnPercent: number | null;
  maxAdverseReturnPercent: number | null;
};

export function evaluateSignalOutcomes(
  signal: {
    observedAt: Date;
    referencePriceUsdt: number | null;
    stance: string;
    invalidationPriceUsdt: number | null;
  },
  candles: Candle[],
  horizonHours: number,
  sourceIsLive: boolean,
): SignalEvaluationResult {
  const unavailable = (
    evaluationStatus: SignalEvaluationResult["evaluationStatus"],
    evaluationReason: string,
  ): SignalEvaluationResult => ({
    horizonHours,
    evaluatedAt: null,
    outcomePriceUsdt: null,
    returnPercent: null,
    directionCorrect: null,
    evaluationStatus,
    evaluationReason,
    invalidationPriceUsdt: signal.invalidationPriceUsdt,
    maxFavorableReturnPercent: null,
    maxAdverseReturnPercent: null,
  });
  const entry = signal.referencePriceUsdt;
  if (
    !sourceIsLive ||
    entry === null ||
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !["bullish", "bearish"].includes(signal.stance)
  ) return unavailable("insufficient_data", "Fresh entry or evaluation data is unavailable.");

  const targetTime = signal.observedAt.getTime() + horizonHours * 60 * 60 * 1_000;
  const isBullish = signal.stance === "bullish";
  const availableForward = candles.filter((candle) =>
    candle.closeTime > signal.observedAt.getTime(),
  );
  const invalidationPrice = signal.invalidationPriceUsdt;
  const invalidationCandle = invalidationPrice === null
    ? undefined
    : availableForward.find((candle) =>
        isBullish
          ? candle.low <= invalidationPrice
          : candle.high >= invalidationPrice,
      );
  const targetCandle = availableForward.find((candle) => candle.closeTime >= targetTime);
  if (!targetCandle && !invalidationCandle) {
    return unavailable("open", "The evaluation horizon has not elapsed in available market data.");
  }
  const isInvalidatedEarly = invalidationCandle !== undefined &&
    (!targetCandle || invalidationCandle.closeTime <= targetCandle.closeTime);
  const evaluatedCandle = isInvalidatedEarly ? invalidationCandle : targetCandle!;
  const forward = availableForward.filter((candle) =>
    candle.closeTime <= evaluatedCandle.closeTime,
  );
  const high = Math.max(...forward.map((candle) => candle.high));
  const low = Math.min(...forward.map((candle) => candle.low));
  const maxFavorable = ((isBullish ? high - entry : entry - low) / entry) * 100;
  const maxAdverse = ((isBullish ? low - entry : entry - high) / entry) * 100;
  const invalidated = isInvalidatedEarly;
  const returnPercent = ((evaluatedCandle.close - entry) / entry) * 100;
  const directionCorrect = isBullish ? returnPercent > 0 : returnPercent < 0;
  const evaluationStatus = invalidated || !directionCorrect ? "failed" : "successful";
  return {
    horizonHours,
    evaluatedAt: new Date(evaluatedCandle.closeTime),
    outcomePriceUsdt: evaluatedCandle.close,
    returnPercent,
    directionCorrect,
    evaluationStatus,
    evaluationReason: invalidated
      ? "The recorded invalidation threshold was crossed before the evaluation horizon."
      : directionCorrect
        ? "The horizon close moved in the recorded signal direction without crossing invalidation."
        : "The horizon close did not move in the recorded signal direction.",
    invalidationPriceUsdt: signal.invalidationPriceUsdt,
    maxFavorableReturnPercent: maxFavorable,
    maxAdverseReturnPercent: maxAdverse,
  };
}

function evidenceNumber(report: FinalReport, metric: string): number | null {
  const value = report.evidence.find((item) => item.metric === metric)?.value;
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

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
    const entryPriceEur = report.currentData.priceEur;
    const rawInvalidation = evidenceNumber(report, "EMA 50");
    const invalidationPriceUsdt = latestCandle && rawInvalidation !== null &&
      ((report.stance === "bullish" && rawInvalidation < latestCandle.close) ||
        (report.stance === "bearish" && rawInvalidation > latestCandle.close))
      ? rawInvalidation
      : null;
    const invalidationPriceEur = invalidationPriceUsdt !== null &&
      latestCandle && entryPriceEur !== null
      ? invalidationPriceUsdt * entryPriceEur / latestCandle.close
      : null;
    return {
      signalKey: latestCandle
        ? `${asset}:${observedAt.toISOString()}:${report.decision}`
        : `${asset}:missing:${report.generatedAt.slice(0, 10)}:${report.decision}`,
      asset,
      signalType: report.decision,
      stance: report.stance,
      confidenceScore: report.confidenceScore,
      observedAt,
      referencePriceUsdt: latestCandle?.close.toFixed(10) ?? null,
      entryPriceEur: entryPriceEur?.toFixed(10) ?? null,
      invalidationPriceUsdt: invalidationPriceUsdt?.toFixed(10) ?? null,
      invalidationPriceEur: invalidationPriceEur?.toFixed(10) ?? null,
      dataStatus: report.dataStatus,
      snapshot: copySignalSnapshot({
        generatedAt: report.generatedAt,
        observedAt: observedAt.toISOString(),
        entryIdea: ["bullish", "bearish"].includes(report.stance)
          ? `Paper-only ${report.stance} reference at ${latestCandle?.close ?? "unavailable"} USDT (${entryPriceEur ?? "unavailable"} EUR).`
          : "No directional paper entry: the recorded signal is neutral or not evaluable.",
        entryPriceEur,
        referencePriceSource: latestCandle ? snapshot.hourlyStatus.source : null,
        referencePriceUsdt: latestCandle?.close ?? null,
        invalidation: report.invalidation,
        invalidationPriceUsdt,
        invalidationPriceEur,
        marketDataStatus: report.dataStatus,
        sourceStatuses: snapshot.sourceStatuses,
        evidence: report.evidence,
        counterArguments: report.counterArguments,
        currentData: report.currentData,
        decision: report.decision,
        stance: report.stance,
        radarState: report.radarState,
        confidenceBreakdown: report.confidenceBreakdown,
        confidenceScore: report.confidenceScore,
        technicalSignals: report.scoreFactors,
        momentumRating: evidenceNumber(report, "Momentum rating"),
        dataSources: snapshot.sourceStatuses,
      }),
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
      const outcomeStatus = snapshot.hourlyStatus.status;
      const candles = snapshot.hourlyCandles;
      const savedSnapshot = signal.snapshot;
      const invalidationPrice = typeof savedSnapshot.invalidationPriceUsdt === "number"
        ? savedSnapshot.invalidationPriceUsdt
        : null;
      const outcome = evaluateSignalOutcomes({
        observedAt: signal.observedAt,
        referencePriceUsdt: reference,
        stance: signal.stance,
        invalidationPriceUsdt: invalidationPrice,
      }, candles, horizonHours, outcomeStatus === "live");
      if (outcome.evaluationStatus === "open" || outcome.evaluationStatus === "insufficient_data") return [];
      return [{
        signalId: signal.id,
        horizonHours,
        evaluatedAt: outcome.evaluatedAt!,
        outcomePriceUsdt: outcome.outcomePriceUsdt!.toFixed(10),
        returnPercent: outcome.returnPercent!.toFixed(6),
        directionCorrect: outcome.directionCorrect,
        evaluationStatus: outcome.evaluationStatus,
        evaluationReason: outcome.evaluationReason,
        invalidationPriceUsdt: outcome.invalidationPriceUsdt?.toFixed(10) ?? null,
        maxFavorableReturnPercent: outcome.maxFavorableReturnPercent?.toFixed(6) ?? null,
        maxAdverseReturnPercent: outcome.maxAdverseReturnPercent?.toFixed(6) ?? null,
        source: snapshot.hourlyStatus.source,
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
      status: group.returns.length >= 5 ? "measured" as const : "insufficient_data" as const,
      directionalSampleCount: group.directionalResults.length,
      hits: group.directionalResults.filter(Boolean).length,
      hitRatePercent: group.directionalResults.length >= 5
        ? Math.round(
            (group.directionalResults.filter(Boolean).length / group.directionalResults.length) * 1000,
          ) / 10
        : null,
      averageReturnPercent: group.returns.length >= 5
        ? Math.round(
            (group.returns.reduce((sum, value) => sum + value, 0) / group.returns.length) * 1000,
          ) / 1000
        : null,
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

export async function getRadarSignalHistory(limit = 100) {
  const signals = await db
    .select()
    .from(radarSignals)
    .orderBy(desc(radarSignals.observedAt))
    .limit(limit);
  if (!signals.length) return [];
  const outcomes = await db
    .select()
    .from(radarSignalOutcomes)
    .where(inArray(radarSignalOutcomes.signalId, signals.map((signal) => signal.id)));
  const outcomesBySignal = new Map<string, typeof outcomes>();
  for (const outcome of outcomes) {
    const rows = outcomesBySignal.get(outcome.signalId) ?? [];
    rows.push(outcome);
    outcomesBySignal.set(outcome.signalId, rows);
  }
  return signals.map((signal) => {
    const snapshot = signal.snapshot;
    const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
    const technicalSignals = Array.isArray(snapshot.technicalSignals) ? snapshot.technicalSignals : [];
    const dataSources = Array.isArray(snapshot.dataSources) ? snapshot.dataSources : [];
    const momentumRating = typeof snapshot.momentumRating === "number" ? snapshot.momentumRating : null;
    return {
      signalId: signal.id,
      asset: signal.asset,
      observedAt: signal.observedAt.toISOString(),
      referencePriceUsdt: signal.referencePriceUsdt === null ? null : Number(signal.referencePriceUsdt),
      entryPriceEur: signal.entryPriceEur === null ? null : Number(signal.entryPriceEur),
      stance: signal.stance,
      confidenceScore: signal.confidenceScore,
      dataStatus: signal.dataStatus,
      entryIdea: typeof snapshot.entryIdea === "string" ? snapshot.entryIdea : "Entry idea was not recorded.",
      invalidation: typeof snapshot.invalidation === "string" ? snapshot.invalidation : "No invalidation was recorded.",
      invalidationPriceUsdt: signal.invalidationPriceUsdt === null ? null : Number(signal.invalidationPriceUsdt),
      invalidationPriceEur: signal.invalidationPriceEur === null ? null : Number(signal.invalidationPriceEur),
      decision: signal.signalType,
      momentumRating,
      evidence,
      technicalSignals,
      dataSources,
      evaluations: evaluationHorizons.map((horizonHours) => {
        const outcome = outcomesBySignal.get(signal.id)?.find((item) => item.horizonHours === horizonHours);
        const horizonElapsed =
          Date.now() >= signal.observedAt.getTime() + horizonHours * 60 * 60 * 1_000;
        const canEvaluate =
          signal.dataStatus === "live" &&
          ["bullish", "bearish"].includes(signal.stance) &&
          signal.referencePriceUsdt !== null;
        return {
          horizonHours,
          evaluatedAt: outcome?.evaluatedAt.toISOString() ?? null,
          returnPercent: outcome ? Number(outcome.returnPercent) : null,
          result: outcome
            ? outcome.evaluationStatus === "not_evaluated"
              ? outcome.directionCorrect === null
                ? "insufficient_data"
                : outcome.directionCorrect ? "successful" : "failed"
              : outcome.evaluationStatus
            : !canEvaluate || horizonElapsed
              ? "insufficient_data"
              : "open",
          reason: outcome?.evaluationReason ?? (
            !canEvaluate
              ? "Signal entry or source data is not sufficient for a real-market evaluation."
              : horizonElapsed
                ? "The evaluation horizon elapsed but complete fresh market data was unavailable."
                : "The evaluation horizon is still open."
          ),
          maxFavorableReturnPercent: outcome?.maxFavorableReturnPercent === null || !outcome
            ? null
            : Number(outcome.maxFavorableReturnPercent),
          maxAdverseReturnPercent: outcome?.maxAdverseReturnPercent === null || !outcome
            ? null
            : Number(outcome.maxAdverseReturnPercent),
        };
      }),
    };
  });
}
