import { and, eq } from "drizzle-orm";
import type {
  AgentEvidence,
  AgentResult,
  AnalysisRun,
  AssetCode,
  ConfidenceBreakdown,
  DataSourceStatus,
  FinalReport,
  ScoreFactor,
  ScoreWeights,
} from "@workspace/api-zod";
import {
  analysisAgentOutputs,
  analysisRuns,
  db,
  type StoredRunEvent,
} from "@workspace/db";
import { getDeskSettings } from "./account-settings";
import { generateGeminiContent, GeminiServiceError } from "./gemini";
import { getMarketSnapshot, type Candle, type MarketSnapshot } from "./market-data";

type AgentDefinition = { id: string; displayName: string };

export const agentDefinitions: AgentDefinition[] = [
  { id: "master", displayName: "Master Agent" },
  { id: "market-structure", displayName: "Market Structure" },
  { id: "technical-analyst", displayName: "Technical Analyst" },
  { id: "momentum-scanner", displayName: "Momentum Scanner" },
  { id: "volume-analyst", displayName: "Volume Analyst" },
  { id: "news-analyst", displayName: "News Analyst" },
  { id: "macro-analyst", displayName: "Macro Analyst" },
  { id: "sentiment-analyst", displayName: "Sentiment Analyst" },
  { id: "social-sentiment", displayName: "Social Sentiment" },
  { id: "on-chain-analyst", displayName: "On-Chain Analyst" },
  { id: "risk-analyst", displayName: "Risk Analyst" },
  { id: "market-scanner", displayName: "Market Scanner" },
  { id: "verification", displayName: "Verification Agent" },
  { id: "final-decision", displayName: "Final Decision Agent" },
];

const evidenceAgents = new Set([
  "market-structure",
  "technical-analyst",
  "momentum-scanner",
  "volume-analyst",
  "news-analyst",
  "macro-analyst",
  "sentiment-analyst",
  "social-sentiment",
  "on-chain-analyst",
  "risk-analyst",
  "market-scanner",
]);
const directionalAgentIds = [
  "market-structure",
  "technical-analyst",
  "momentum-scanner",
  "volume-analyst",
];
const agentById = new Map(agentDefinitions.map((agent) => [agent.id, agent]));
const controllers = new Map<string, AbortController>();

class RunStoppedError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function missingSource(source: string, detail: string): DataSourceStatus {
  const checkedAt = nowIso();
  return {
    source,
    status: "missing",
    checkedAt,
    observedAt: null,
    ageMinutes: null,
    detail,
  };
}

function aggregateDataStatus(sources: DataSourceStatus[]): "live" | "stale" | "missing" {
  if (sources.some((source) => source.status === "live")) return "live";
  if (sources.some((source) => source.status === "stale")) return "stale";
  return "missing";
}

function baseResult(
  agentId: string,
  patch: Partial<AgentResult> = {},
): AgentResult {
  const definition = agentById.get(agentId);
  return {
    agentId,
    displayName: definition?.displayName ?? agentId,
    status: "complete",
    stance: "not_evaluable",
    summary: "Nicht bewertbar.",
    confidence: 0,
    bullishFactors: [],
    bearishFactors: [],
    risks: [],
    rationale: "",
    evidence: [],
    source: "Keine Datenquelle",
    timestamp: nowIso(),
    dataStatus: "missing",
    dataSources: [missingSource("Market data", "No connected data source returned evidence.")],
    error: null,
    ...patch,
  };
}

function makeEvidence(
  metric: string,
  value: string,
  source: string,
  timestamp: string | null,
  dataStatus: "live" | "stale" | "missing",
): AgentEvidence {
  return {
    metric,
    value,
    source,
    timestamp: timestamp ?? nowIso(),
    dataStatus,
  };
}

function money(value: number): string {
  return `€${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function evidenceTimestamp(status: DataSourceStatus, fallback: string): string {
  return status.observedAt ?? fallback;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  return values.slice(period).reduce((previous, value) => value * multiplier + previous * (1 - multiplier), seed);
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes = values.slice(-period - 1).slice(1).map((value, index) => value - values.slice(-period - 1)[index]);
  const gains = changes.map((change) => Math.max(change, 0));
  const losses = changes.map((change) => Math.max(-change, 0));
  const averageGain = gains.reduce((sum, value) => sum + value, 0) / period;
  const averageLoss = losses.reduce((sum, value) => sum + value, 0) / period;
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null;
  const sample = candles.slice(-period - 1);
  const trueRanges = sample.slice(1).map((candle, index) => {
    const previousClose = sample[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function calculateTechnical(snapshot: MarketSnapshot): {
  output: AgentResult;
  indicators: {
    close: number | null;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    rsi14: number | null;
    atr14: number | null;
    atrPercent: number | null;
    breakout: "above" | "below" | "inside" | null;
  };
} {
  const candles = snapshot.dailyCandles;
  const closes = candles.map((candle) => candle.close);
  const last = candles.at(-1);
  const close = last?.close ?? null;
  const ema20 = ema(closes.slice(-Math.max(20, closes.length)), 20);
  const ema50 = ema(closes.slice(-Math.max(50, closes.length)), 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const atrPercent = close && atr14 ? (atr14 / close) * 100 : null;
  const previous20 = candles.slice(-21, -1);
  const high20 = previous20.length === 20 ? Math.max(...previous20.map((candle) => candle.high)) : null;
  const low20 = previous20.length === 20 ? Math.min(...previous20.map((candle) => candle.low)) : null;
  const breakout =
    close !== null && high20 !== null && low20 !== null
      ? close > high20
        ? "above"
        : close < low20
          ? "below"
          : "inside"
      : null;
  const adequate = close !== null && ema20 !== null && ema50 !== null && rsi14 !== null && atr14 !== null;
  const fullyAligned = ema200 !== null && close! > ema20! && ema20! > ema50! && ema50! > ema200;
  const fullyDown = ema200 !== null && close! < ema20! && ema20! < ema50! && ema50! < ema200;
  const stance = !adequate
    ? "not_evaluable"
    : fullyAligned && rsi14! < 70
      ? "bullish"
      : fullyDown && rsi14! > 30
        ? "bearish"
        : "neutral";
  const sourceStatus = snapshot.dailyStatus;
  const evidence = adequate
    ? [
        makeEvidence("Daily close", money(close!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
        makeEvidence("EMA 20", money(ema20!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
        makeEvidence("EMA 50", money(ema50!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
        ...(ema200 === null ? [] : [makeEvidence("EMA 200", money(ema200), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status)]),
        makeEvidence("RSI 14", rsi14!.toFixed(1), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
        makeEvidence("ATR 14", money(atr14!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
      ]
    : [];
  const strength = adequate
    ? Math.min(
        90,
        Math.round(
          25 +
            Math.abs(((close! - ema50!) / ema50!) * 100) * 2 +
            Math.abs(rsi14! - 50) * 0.3 +
            (ema200 === null ? 0 : 10),
        ),
      )
    : 0;
  const output = baseResult("technical-analyst", {
    stance,
    summary: adequate
      ? `${snapshot.asset} daily indicators: close ${money(close!)}, EMA20 ${money(ema20!)}, EMA50 ${money(ema50!)}, RSI14 ${rsi14!.toFixed(1)}.`
      : "Nicht bewertbar: Für EMA, RSI und ATR liegen nicht genügend echte Tageskerzen vor.",
    confidence: sourceStatus.status === "live" ? strength : Math.round(strength * 0.5),
    bullishFactors: adequate
      ? [
          ...(close! > ema20! ? [`Kurs liegt über EMA 20 (${money(ema20!)})`] : []),
          ...(ema200 !== null && close! > ema200 ? [`Kurs liegt über EMA 200 (${money(ema200)})`] : []),
        ]
      : [],
    bearishFactors: adequate
      ? [
          ...(close! < ema20! ? [`Kurs liegt unter EMA 20 (${money(ema20!)})`] : []),
          ...(ema200 !== null && close! < ema200 ? [`Kurs liegt unter EMA 200 (${money(ema200)})`] : []),
        ]
      : [],
    risks: adequate
      ? [
          ...(rsi14! >= 70 ? [`RSI 14 liegt bei ${rsi14!.toFixed(1)} (überkauft)`] : []),
          ...(rsi14! <= 30 ? [`RSI 14 liegt bei ${rsi14!.toFixed(1)} (überverkauft)`] : []),
          ...(ema200 === null ? ["Für EMA 200 sind weniger als 200 Tageskerzen vorhanden."] : []),
        ]
      : ["Tageskerzen fehlen oder sind nicht frisch genug."],
    rationale: adequate
      ? "Deterministische technische Auswertung der zuletzt abgerufenen abgeschlossenen Binance-Tageskerzen."
      : "Die benötigten Eingangsdaten fehlen; es wird keine Richtung abgeleitet.",
    evidence,
    source: sourceStatus.source,
    dataStatus: adequate ? sourceStatus.status : "missing",
    dataSources: [sourceStatus],
  });
  return {
    output,
    indicators: { close, ema20, ema50, ema200, rsi14, atr14, atrPercent, breakout },
  };
}

function calculateMomentum(snapshot: MarketSnapshot): {
  output: AgentResult;
  change6h: number | null;
  change24h: number | null;
} {
  const candles = snapshot.hourlyCandles;
  const last = candles.at(-1);
  const sixAgo = candles.at(-7);
  const dayAgo = candles.at(-25);
  const change6h =
    last && sixAgo && sixAgo.close > 0 ? ((last.close - sixAgo.close) / sixAgo.close) * 100 : null;
  const change24h =
    last && dayAgo && dayAgo.close > 0 ? ((last.close - dayAgo.close) / dayAgo.close) * 100 : null;
  const adequate = change6h !== null && change24h !== null;
  const stance =
    !adequate
      ? "not_evaluable"
      : change6h! > 0.5 && change24h! > 0.5
        ? "bullish"
        : change6h! < -0.5 && change24h! < -0.5
          ? "bearish"
          : "neutral";
  const sourceStatus = snapshot.hourlyStatus;
  const confidence = adequate
    ? Math.min(90, Math.round(Math.abs(change6h!) * 3 + Math.abs(change24h!) * 2))
    : 0;
  return {
    change6h,
    change24h,
    output: baseResult("momentum-scanner", {
      stance,
      summary: adequate
        ? `Stündliches Momentum: ${pct(change6h!)} über 6h und ${pct(change24h!)} über 24h.`
        : "Nicht bewertbar: Für 6h- und 24h-Momentum fehlen abgeschlossene Stundenkerzen.",
      confidence: sourceStatus.status === "live" ? confidence : Math.round(confidence * 0.5),
      bullishFactors: adequate && change6h! > 0 && change24h! > 0 ? [`6h ${pct(change6h!)}`, `24h ${pct(change24h!)}`] : [],
      bearishFactors: adequate && change6h! < 0 && change24h! < 0 ? [`6h ${pct(change6h!)}`, `24h ${pct(change24h!)}`] : [],
      risks: adequate && Math.sign(change6h!) !== Math.sign(change24h!) ? ["Kurzfristiger und 24h-Trend widersprechen sich."] : [],
      rationale: adequate
        ? "Berechnet aus den letzten abgeschlossenen Binance-Stundenkerzen."
        : "Mindestens 25 abgeschlossene Stundenkerzen werden benötigt.",
      evidence: adequate
        ? [
            makeEvidence("6h price change", pct(change6h!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
            makeEvidence("24h price change", pct(change24h!), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
          ]
        : [],
      source: sourceStatus.source,
      dataStatus: adequate ? sourceStatus.status : "missing",
      dataSources: [sourceStatus],
    }),
  };
}

function calculateMarketStructure(snapshot: MarketSnapshot): AgentResult {
  const cgUsd = snapshot.sourceStatuses.find((source) => source.source === "CoinGecko · USD");
  const binance = snapshot.sourceStatuses.find((source) => source.source === "Binance · USDT ticker");
  const sources = [cgUsd, binance].filter((item): item is DataSourceStatus => Boolean(item));
  const bothLive = Boolean(cgUsd && binance && cgUsd.status === "live" && binance.status === "live");
  const deviation = snapshot.sourceDeviationPercent;
  const priceChange = snapshot.change24hPercent;
  const evaluable = bothLive && deviation !== null && priceChange !== null;
  const stance = !evaluable
    ? "not_evaluable"
    : deviation! > 1
      ? "neutral"
      : priceChange! > 0.5
        ? "bullish"
        : priceChange! < -0.5
          ? "bearish"
          : "neutral";
  const evidence = evaluable
    ? [
        makeEvidence(
          "CoinGecko / Binance price deviation",
          `${deviation!.toFixed(3)}%`,
          "CoinGecko USD vs Binance USDT",
          [cgUsd!.observedAt, binance!.observedAt].filter(Boolean).sort().at(-1) ?? nowIso(),
          "live",
        ),
        makeEvidence(
          "24h change",
          pct(priceChange!),
          binance!.source,
          binance!.observedAt,
          binance!.status,
        ),
      ]
    : [];
  return baseResult("market-structure", {
    stance,
    summary: evaluable
      ? `Quellenvergleich: ${deviation!.toFixed(3)}% Preisabweichung; 24h-Veränderung ${pct(priceChange!)}.`
      : "Nicht bewertbar: CoinGecko- und Binance-Quotes müssen beide live und vergleichbar sein.",
    confidence: evaluable ? Math.max(0, Math.round(90 - deviation! * 20)) : 0,
    bullishFactors: stance === "bullish" ? [`24h-Veränderung ${pct(priceChange!)}`, "CoinGecko und Binance stimmen innerhalb von 1% überein."] : [],
    bearishFactors: stance === "bearish" ? [`24h-Veränderung ${pct(priceChange!)}`, "CoinGecko und Binance stimmen innerhalb von 1% überein."] : [],
    risks: deviation !== null && deviation > 1 ? [`Quellenabweichung von ${deviation.toFixed(3)}% überschreitet 1%.`] : [],
    rationale: evaluable
      ? "Richtung wird nur bei zwei frischen öffentlichen Preisquellen und einer Abweichung von höchstens 1% bewertet."
      : "Mindestens eine der beiden unabhängigen Preisquellen fehlt oder ist veraltet.",
    evidence,
    source: "CoinGecko USD + Binance USDT ticker",
    dataStatus: evaluable ? "live" : aggregateDataStatus(sources),
    dataSources: sources.length ? sources : [missingSource("CoinGecko + Binance", "No comparable source data.")],
  });
}

function calculateVolume(snapshot: MarketSnapshot): AgentResult {
  const candles = snapshot.hourlyCandles;
  const sourceStatus = snapshot.hourlyStatus;
  if (candles.length < 48) {
    return baseResult("volume-analyst", {
      summary: "Nicht bewertbar: Für den Vergleich von zwei 24h-Volumenperioden fehlen abgeschlossene Stundenkerzen.",
      rationale: "Es werden mindestens 48 abgeschlossene Stundenkerzen benötigt.",
      source: sourceStatus.source,
      dataSources: [sourceStatus],
    });
  }
  const last24 = candles.slice(-24).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const previous24 = candles.slice(-48, -24).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  if (previous24 <= 0) {
    return baseResult("volume-analyst", {
      summary: "Nicht bewertbar: Das vorherige 24h-Volumen ist nicht positiv.",
      source: sourceStatus.source,
      dataSources: [sourceStatus],
    });
  }
  const change = ((last24 - previous24) / previous24) * 100;
  const priceChange = snapshot.change24hPercent;
  const stance =
    priceChange === null
      ? "not_evaluable"
      : change > 20 && priceChange > 0
        ? "bullish"
        : change > 20 && priceChange < 0
          ? "bearish"
          : "neutral";
  return baseResult("volume-analyst", {
    stance,
    summary: `Abgeschlossenes Stundenvolumen: ${change >= 0 ? "+" : ""}${change.toFixed(1)}% gegenüber den vorherigen 24h.`,
    confidence: sourceStatus.status === "live" ? Math.min(85, Math.round(Math.abs(change) * 1.2)) : Math.round(Math.abs(change) * 0.4),
    bullishFactors: stance === "bullish" ? [`Volumen ${change.toFixed(1)}% höher bei positivem 24h-Preisverlauf.`] : [],
    bearishFactors: stance === "bearish" ? [`Volumen ${change.toFixed(1)}% höher bei negativem 24h-Preisverlauf.`] : [],
    risks: Math.abs(change) > 100 ? ["Ungewöhnlich starke Volumenänderung; Ausreißer oder Ereignis möglich."] : [],
    rationale: "Volumenänderung wird aus den letzten 24 gegenüber den vorherigen 24 abgeschlossenen Stundenkerzen berechnet.",
    evidence: [
      makeEvidence("24h quote-volume change", `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
      makeEvidence("Latest 24h quote volume", last24.toFixed(2), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
      ...(priceChange === null ? [] : [makeEvidence("24h price change", pct(priceChange), "Market quote", snapshot.generatedAt, aggregateDataStatus(snapshot.sourceStatuses))]),
    ],
    source: sourceStatus.source,
    dataStatus: sourceStatus.status,
    dataSources: [sourceStatus, ...snapshot.sourceStatuses.slice(0, 3)],
  });
}

function calculateRisk(snapshot: MarketSnapshot): {
  output: AgentResult;
  riskScore: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
} {
  const candles = snapshot.dailyCandles;
  const closes = candles.map((candle) => candle.close).filter((value) => value > 0);
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const dailyDeviation = stdev(returns.slice(-30));
  const volatility = dailyDeviation === null ? null : dailyDeviation * Math.sqrt(365) * 100;
  let peak = 0;
  let maxDrawdown = 0;
  for (const close of closes.slice(-90)) {
    peak = Math.max(peak, close);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - close) / peak) * 100);
  }
  const deviation = snapshot.sourceDeviationPercent;
  const isEvaluable = volatility !== null && closes.length >= 30;
  const riskScore = isEvaluable
    ? Math.round(
        Math.min(
          100,
          Math.max(
            0,
            volatility! * 1.3 +
              maxDrawdown * 0.8 +
              (deviation === null ? 15 : deviation * 5),
          ),
        ),
      )
    : null;
  const sourceStatus = snapshot.dailyStatus;
  return {
    volatility,
    maxDrawdown: isEvaluable ? maxDrawdown : null,
    riskScore,
    output: baseResult("risk-analyst", {
      stance: isEvaluable ? "neutral" : "not_evaluable",
      summary: isEvaluable
        ? `Annualisierte 30-Tage-Volatilität ${volatility!.toFixed(1)}%, maximaler 90-Tage-Drawdown ${maxDrawdown.toFixed(1)}%; Risk Score ${riskScore}/100.`
        : "Nicht bewertbar: Für Volatilität und Drawdown liegen nicht genügend Tageskerzen vor.",
      confidence: isEvaluable && sourceStatus.status === "live" ? Math.min(90, Math.round(40 + closes.length / 5)) : 0,
      bullishFactors: [],
      bearishFactors: [],
      risks: isEvaluable
        ? [
            `Annualisierte 30-Tage-Volatilität: ${volatility!.toFixed(1)}%.`,
            `Maximaler 90-Tage-Drawdown: ${maxDrawdown.toFixed(1)}%.`,
            ...(deviation === null ? ["CoinGecko/Binance-Abweichung fehlt."] : [`Quellenabweichung: ${deviation.toFixed(3)}%.`]),
          ]
        : ["Risiko kann mangels ausreichender Tageskerzen nicht berechnet werden."],
      rationale: "Risk Score basiert auf annualisierter Volatilität, maximalem 90-Tage-Drawdown und der Preisabweichung öffentlicher Quellen.",
      evidence: isEvaluable
        ? [
            makeEvidence("Annualized volatility, 30d", `${volatility!.toFixed(2)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
            makeEvidence("Maximum drawdown, 90d", `${maxDrawdown.toFixed(2)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
            ...(deviation === null ? [] : [makeEvidence("Source deviation", `${deviation.toFixed(3)}%`, "CoinGecko USD vs Binance USDT", snapshot.generatedAt, "live")]),
          ]
        : [],
      source: sourceStatus.source,
      dataStatus: isEvaluable ? sourceStatus.status : "missing",
      dataSources: [sourceStatus, ...snapshot.sourceStatuses.slice(0, 3)],
    }),
  };
}

function unavailableAgent(agentId: string, dataSource: string, detail: string): AgentResult {
  return baseResult(agentId, {
    status: "complete",
    stance: "not_evaluable",
    summary: `Nicht angebunden / Daten fehlend: ${detail}`,
    confidence: 0,
    rationale: "Für diesen Agent ist in dieser Version keine überprüfbare Datenquelle angeschlossen.",
    source: dataSource,
    dataStatus: "missing",
    dataSources: [missingSource(dataSource, detail)],
  });
}

function expectedSourceStatus(snapshot: MarketSnapshot, sourceName: string): DataSourceStatus {
  return (
    snapshot.sourceStatuses.find((source) => source.source === sourceName) ??
    missingSource(sourceName, "Source status was not available.")
  );
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function addRunEvent(
  runId: string,
  accountId: string,
  agent: string,
  message: string,
  kind: StoredRunEvent["kind"],
): Promise<void> {
  const [run] = await db
    .select({ activity: analysisRuns.activity })
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.accountId, accountId)))
    .limit(1);
  if (!run) return;
  const current = run.activity ?? [];
  const event: StoredRunEvent = {
    id: current.length ? Math.max(...current.map((item) => item.id)) + 1 : 1,
    agent,
    message,
    timestamp: nowIso(),
    kind,
  };
  await db
    .update(analysisRuns)
    .set({ activity: [...current, event], updatedAt: new Date() })
    .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.accountId, accountId)));
}

async function saveAgentResult(
  runId: string,
  accountId: string,
  result: AgentResult,
  rawSnapshot: unknown,
): Promise<void> {
  await db
    .update(analysisAgentOutputs)
    .set({
      status: result.status,
      stance: result.stance,
      summary: result.summary,
      confidence: result.confidence,
      bullishFactors: result.bullishFactors,
      bearishFactors: result.bearishFactors,
      risks: result.risks,
      rationale: result.rationale,
      evidence: result.evidence,
      source: result.source,
      timestamp: new Date(result.timestamp),
      dataStatus: result.dataStatus,
      dataSources: result.dataSources,
      error: result.error,
      rawSnapshot: toJsonObject(rawSnapshot),
    })
    .where(
      and(
        eq(analysisAgentOutputs.runId, runId),
        eq(analysisAgentOutputs.agentId, result.agentId),
      ),
    );
  await addRunEvent(
    runId,
    accountId,
    result.displayName,
    result.status === "error" ? result.error ?? "Agent failed." : result.summary,
    result.status === "error" ? "error" : "complete",
  );
}

async function markAgentWorking(
  runId: string,
  accountId: string,
  agentId: string,
): Promise<void> {
  const agent = agentById.get(agentId);
  await db
    .update(analysisAgentOutputs)
    .set({ status: "working", timestamp: new Date() })
    .where(and(eq(analysisAgentOutputs.runId, runId), eq(analysisAgentOutputs.agentId, agentId)));
  await addRunEvent(runId, accountId, agent?.displayName ?? agentId, "Analysiert die verfügbaren Quellen.", "working");
}

function runWasStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new RunStoppedError("Run stopped by user.");
}

async function executeAgent(
  runId: string,
  accountId: string,
  agentId: string,
  signal: AbortSignal,
  work: () => Promise<{ result: AgentResult; snapshot: unknown }> | { result: AgentResult; snapshot: unknown },
  results: Map<string, AgentResult>,
): Promise<void> {
  runWasStopped(signal);
  await markAgentWorking(runId, accountId, agentId);
  try {
    const { result, snapshot } = await work();
    runWasStopped(signal);
    results.set(agentId, result);
    await saveAgentResult(runId, accountId, result, snapshot);
  } catch (error) {
    if (error instanceof RunStoppedError || signal.aborted) throw new RunStoppedError();
    const failure = baseResult(agentId, {
      status: "error",
      summary: "Agent konnte seine Berechnung nicht abschließen. Andere Agents laufen weiter.",
      error: "Agent calculation failed. No result was generated.",
      dataStatus: "missing",
      source: "Agent calculation",
      dataSources: [missingSource("Agent calculation", "The calculation failed.")],
    });
    results.set(agentId, failure);
    await saveAgentResult(runId, accountId, failure, { errorType: error instanceof Error ? error.name : "unknown" });
  }
}

function makeGeminiSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      stance: {
        type: "STRING",
        enum: ["bullish", "bearish", "neutral", "not_evaluable"],
      },
      summary: { type: "STRING" },
      confidence: { type: "INTEGER" },
      bullishFactors: { type: "ARRAY", items: { type: "STRING" } },
      bearishFactors: { type: "ARRAY", items: { type: "STRING" } },
      risks: { type: "ARRAY", items: { type: "STRING" } },
      rationale: { type: "STRING" },
      evidenceIds: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: [
      "stance",
      "summary",
      "confidence",
      "bullishFactors",
      "bearishFactors",
      "risks",
      "rationale",
      "evidenceIds",
    ],
  };
}

type GeminiMarketResult = {
  stance: AgentResult["stance"];
  summary: string;
  confidence: number;
  bullishFactors: string[];
  bearishFactors: string[];
  risks: string[];
  rationale: string;
  evidenceIds: string[];
};

function parseGeminiResult(text: string): GeminiMarketResult | null {
  try {
    const value = JSON.parse(text) as Partial<GeminiMarketResult>;
    const stances = ["bullish", "bearish", "neutral", "not_evaluable"];
    if (
      !value ||
      !stances.includes(String(value.stance)) ||
      typeof value.summary !== "string" ||
      typeof value.rationale !== "string" ||
      !Number.isInteger(value.confidence) ||
      Number(value.confidence) < 0 ||
      Number(value.confidence) > 100 ||
      !Array.isArray(value.evidenceIds) ||
      !Array.isArray(value.bullishFactors) ||
      !Array.isArray(value.bearishFactors) ||
      !Array.isArray(value.risks) ||
      ![...value.evidenceIds, ...value.bullishFactors, ...value.bearishFactors, ...value.risks].every(
        (item) => typeof item === "string",
      )
    ) {
      return null;
    }
    return value as GeminiMarketResult;
  } catch {
    return null;
  }
}

async function runMarketScanner(
  question: string,
  snapshot: MarketSnapshot,
  sourceResults: AgentResult[],
  signal: AbortSignal,
): Promise<AgentResult> {
  const evidenceRefs = sourceResults.flatMap((result) =>
    result.evidence.map((evidence, index) => ({
      id: `${result.agentId}:${index + 1}`,
      evidence,
    })),
  );
  const systemInstruction = [
    "Du bist ein vorsichtiger Market-Analysis-Spezialist.",
    "Nutze ausschließlich die im User-Kontext enthaltenen Marktdaten und Evidence-IDs.",
    "Erfinde keine Preise, Kennzahlen, Quellen oder Zeitstempel. Keine externe Recherche behaupten.",
    "Wenn keine passende Live-Evidence vorhanden ist, setze stance auf not_evaluable.",
    "Gib ausschließlich das angeforderte strukturierte JSON zurück.",
    "Keine Kauf-/Verkaufsempfehlung und keine Anlageberatung.",
  ].join(" ");
  const requestContext = {
    question,
    asset: snapshot.asset,
    marketSnapshot: {
      generatedAt: snapshot.generatedAt,
      priceEur: snapshot.priceEur,
      priceUsd: snapshot.priceUsd,
      change24hPercent: snapshot.change24hPercent,
      change7dPercent: snapshot.change7dPercent,
      volume24hEur: snapshot.volume24hEur,
      sourceDeviationPercent: snapshot.sourceDeviationPercent,
      sources: snapshot.sourceStatuses,
      candles: {
        hourly: {
          status: snapshot.hourlyStatus,
          latest: snapshot.hourlyCandles.at(-1) ?? null,
        },
        daily: {
          status: snapshot.dailyStatus,
          latest: snapshot.dailyCandles.at(-1) ?? null,
        },
      },
    },
    evidence: evidenceRefs.map(({ id, evidence }) => ({
      id,
      metric: evidence.metric,
      value: evidence.value,
      source: evidence.source,
      timestamp: evidence.timestamp,
      dataStatus: evidence.dataStatus,
    })),
  };

  const generated = await generateGeminiContent({
    question: JSON.stringify(requestContext),
    systemInstruction,
    responseSchema: makeGeminiSchema(),
    signal,
    maxOutputTokens: 1000,
  });
  const parsed = parseGeminiResult(generated.text);
  const geminiStatus: DataSourceStatus = {
    source: `Google Gemini API · ${generated.model}`,
    status: "live",
    checkedAt: generated.generatedAt,
    observedAt: generated.generatedAt,
    ageMinutes: 0,
    detail: "Structured model response received.",
  };
  const byId = new Map(evidenceRefs.map((ref) => [ref.id, ref.evidence]));
  const marketStatuses = snapshot.sourceStatuses;

  if (!parsed) {
    return baseResult("market-scanner", {
      status: "error",
      summary: "Gemini lieferte kein gültiges strukturiertes Ergebnis. Es wurde keine Bewertung übernommen.",
      error: "Gemini response did not match the required structured format.",
      source: geminiStatus.source,
      dataStatus: "missing",
      dataSources: [geminiStatus, ...marketStatuses],
      rationale: "Ungültiges JSON oder fehlende Pflichtfelder; keine Ersatzanalyse wurde erzeugt.",
    });
  }

  if (parsed.evidenceIds.some((id) => !byId.has(id))) {
    return baseResult("market-scanner", {
      status: "error",
      summary: "Gemini verwies auf Belege, die nicht im bereitgestellten Datensatz enthalten waren.",
      error: "Gemini cited an evidence ID that was not supplied to the model.",
      source: geminiStatus.source,
      dataStatus: "missing",
      dataSources: [geminiStatus, ...marketStatuses],
      rationale: "Nicht verifizierbare Modellbelege werden verworfen.",
    });
  }

  const evidence = parsed.evidenceIds.map((id) => byId.get(id)!).filter(Boolean);
  const hasLiveMarketEvidence = evidence.some((item) => item.dataStatus === "live");
  const stance =
    hasLiveMarketEvidence || parsed.stance === "not_evaluable"
      ? parsed.stance
      : "not_evaluable";
  return baseResult("market-scanner", {
    stance,
    summary:
      stance === "not_evaluable" && parsed.stance !== "not_evaluable"
        ? "Nicht bewertbar: Gemini erhielt keine passende Live-Evidence für diese Einordnung."
        : parsed.summary,
    confidence: evidence.length ? parsed.confidence : 0,
    bullishFactors: stance === "bullish" ? parsed.bullishFactors : [],
    bearishFactors: stance === "bearish" ? parsed.bearishFactors : [],
    risks: parsed.risks,
    rationale: parsed.rationale,
    evidence,
    source: geminiStatus.source,
    dataStatus: "live",
    dataSources: [geminiStatus, ...marketStatuses],
  });
}

function verifyResults(results: AgentResult[], snapshot: MarketSnapshot): AgentResult {
  const sourceRows = snapshot.sourceStatuses;
  const sourceNames = new Set(sourceRows.map((source) => source.source));
  const findings: string[] = [];
  let checkedEvidence = 0;
  let missingEvidence = 0;
  const directional = results.filter(
    (result) =>
      result.dataStatus === "live" &&
      ["bullish", "bearish"].includes(result.stance) &&
      directionalAgentIds.includes(result.agentId),
  );
  if (!results.some((result) => result.evidence.length > 0)) {
    findings.push("Keine Agenten haben Belege geliefert, die gegen einen Rohdaten-Snapshot geprüft werden können.");
  }
  for (const result of results) {
    for (const item of result.evidence) {
      checkedEvidence += 1;
      if (item.dataStatus === "missing") {
        missingEvidence += 1;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ ist als fehlend markiert.`);
      } else if (!sourceNames.has(item.source) && !item.source.includes("Binance")) {
        findings.push(`${result.displayName}: Quelle „${item.source}“ ist nicht im aktuellen Quellenstatus enthalten.`);
      }
      if (!Number.isFinite(Date.parse(item.timestamp))) {
        missingEvidence += 1;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ hat keinen gültigen ISO-Zeitstempel.`);
      }
    }
    for (const source of result.dataSources) {
      if (source.status === "stale") {
        findings.push(`${result.displayName}: Quelle „${source.source}“ ist veraltet (${source.ageMinutes ?? "unbekannt"} Min.).`);
      }
      if (source.status === "missing") {
        findings.push(`${result.displayName}: Quelle „${source.source}“ fehlt.`);
      }
    }
  }
  const hasBull = directional.some((result) => result.stance === "bullish");
  const hasBear = directional.some((result) => result.stance === "bearish");
  if (hasBull && hasBear) findings.push("Widerspruch: Live-Daten-Agents liefern sowohl bullish als auch bearish.");
  if (!findings.length) findings.push("Alle vorliegenden Belege haben einen Zeitstempel und eine verfügbare Quellenzuordnung.");
  const status = results.some((result) => result.evidence.length > 0)
    ? aggregateDataStatus(sourceRows)
    : "missing";
  return baseResult("verification", {
    stance: hasBull && hasBear ? "neutral" : "not_evaluable",
    summary: `${checkedEvidence} Belege geprüft; ${findings.length} konkrete Befunde.`,
    confidence: checkedEvidence ? Math.max(0, 100 - missingEvidence * 20 - findings.filter((item) => item.includes("Widerspruch")).length * 25) : 0,
    bullishFactors: [],
    bearishFactors: [],
    risks: findings,
    rationale: "Prüfung gegen gespeicherte Agent-Belege, Quellenstatus und Zeitstempel des aktuellen Runs.",
    evidence: [],
    source: "Run-Evidence + Rohdaten-Snapshot",
    dataStatus: status,
    dataSources: sourceRows.length ? sourceRows : [missingSource("Run evidence", "No source statuses were recorded.")],
  });
}

function calculateScoreFactors(
  weights: ScoreWeights,
  technical: ReturnType<typeof calculateTechnical>["indicators"],
  momentum: ReturnType<typeof calculateMomentum>,
  volume: AgentResult,
  riskScore: number | null,
  results: AgentResult[],
  snapshot: MarketSnapshot,
): ScoreFactor[] {
  const weight = (key: keyof ScoreWeights) => weights[key];
  const marketStatus = aggregateDataStatus(snapshot.sourceStatuses);
  const technicalAvailable = technical.close !== null && technical.ema20 !== null && technical.ema50 !== null && technical.rsi14 !== null;
  const momentumValue =
    momentum.change6h === null || momentum.change24h === null
      ? null
      : Math.max(0, Math.min(100, 50 + (momentum.change6h + momentum.change24h) * 2));
  const volumeChange = volume.evidence.find((item) => item.metric === "24h quote-volume change");
  const parsedVolume = volumeChange ? Number.parseFloat(volumeChange.value) : Number.NaN;
  const directional = results.filter(
    (result) =>
      directionalAgentIds.includes(result.agentId) &&
      result.dataStatus === "live" &&
      ["bullish", "bearish"].includes(result.stance),
  );
  const consensusValue =
    directional.length < 2
      ? null
      : Math.round(
          (directional.filter((result) => result.stance === directional[0].stance).length /
            directional.length) *
            100,
        );

  const factor = (
    name: string,
    value: number | null,
    factorWeight: number,
    status: DataSourceStatus["status"],
    explanation: string,
  ): ScoreFactor => ({
    name,
    value,
    weight: factorWeight,
    dataStatus: value === null ? "missing" : status,
    explanation,
  });
  const trendValue =
    technicalAvailable && technical.ema50
      ? technical.close! > technical.ema50
        ? 75
        : technical.close! < technical.ema50
          ? 25
          : 50
      : null;
  const emaValue =
    technicalAvailable && technical.ema200 !== null
      ? technical.close! > technical.ema20! && technical.ema20! > technical.ema50! && technical.ema50! > technical.ema200
        ? 100
        : technical.close! < technical.ema20! && technical.ema20! < technical.ema50! && technical.ema50! < technical.ema200
          ? 0
          : 50
      : null;
  const rsiValue =
    technical.rsi14 === null
      ? null
      : Math.max(0, Math.min(100, 50 + (50 - technical.rsi14) * 0.8));
  const atrValue =
    technical.atrPercent === null
      ? null
      : Math.max(0, Math.min(100, 100 - technical.atrPercent * 8));
  const volumeScore =
    Number.isFinite(parsedVolume) && snapshot.change24hPercent !== null
      ? Math.max(0, Math.min(100, 50 + Math.sign(snapshot.change24hPercent) * parsedVolume * 0.3))
      : null;
  const breakoutScore =
    technical.breakout === null
      ? null
      : technical.breakout === "above"
        ? 100
        : technical.breakout === "below"
          ? 0
          : 50;
  const riskFactor = riskScore === null ? null : 100 - riskScore;
  const commonStatus = technicalAvailable ? snapshot.dailyStatus.status : "missing";
  return [
    factor("trend", trendValue, weight("trend"), commonStatus, "Preis im Verhältnis zur EMA 50; positiv über, negativ unter dem Durchschnitt."),
    factor("ema", emaValue, weight("ema"), commonStatus, "Ausrichtung von EMA 20, 50 und 200."),
    factor("rsi", rsiValue, weight("rsi"), commonStatus, "Richtungswert aus RSI 14; Extremwerte werden gedämpft."),
    factor("atr", atrValue, weight("atr"), commonStatus, "Risikofaktor aus ATR 14 in Prozent des Schlusskurses."),
    factor("momentum", momentumValue, weight("momentum"), snapshot.hourlyStatus.status, "Aus den Änderungen der letzten 6h und 24h."),
    factor("volume", volumeScore, weight("volume"), volume.dataStatus, "Änderung des 24h-Stundenvolumens im Preis-Kontext."),
    factor("breakout", breakoutScore, weight("breakout"), commonStatus, "Letzter Schlusskurs relativ zur 20-Tage-Spanne."),
    factor("news", null, weight("news"), "missing", "Keine News-Quelle angebunden."),
    factor("sentiment", null, weight("sentiment"), "missing", "Keine Social-/Sentiment-Quelle angebunden."),
    factor("macro", null, weight("macro"), "missing", "Keine Makrodatenquelle angebunden."),
    factor("risk", riskFactor, weight("risk"), riskScore === null ? "missing" : snapshot.dailyStatus.status, "100 minus berechneter Risk Score; senkt beide Richtungen bei hohem Risiko."),
    factor("consensus", consensusValue, weight("consensus"), directional.length ? "live" : "missing", "Übereinstimmung der live datenbasierten Richtungs-Agents; kein Mehrheitsentscheid."),
  ];
}

function weightedScores(factors: ScoreFactor[]): { longScore: number | null; shortScore: number | null } {
  const available = factors.filter((factor) => factor.value !== null && factor.weight > 0);
  if (!available.length) return { longScore: null, shortScore: null };
  const totalWeight = available.reduce((sum, factor) => sum + factor.weight, 0);
  const longScore = available.reduce((sum, factor) => sum + factor.value! * factor.weight, 0) / totalWeight;
  const shortScore =
    available.reduce((sum, factor) => sum + (100 - factor.value!) * factor.weight, 0) / totalWeight;
  return {
    longScore: Math.round(longScore),
    shortScore: Math.round(shortScore),
  };
}

export function buildFinalReport(
  results: AgentResult[],
  snapshot: MarketSnapshot,
  weights: ScoreWeights,
  indicators: ReturnType<typeof calculateTechnical>["indicators"],
  momentum: ReturnType<typeof calculateMomentum>,
  riskScore: number | null,
): FinalReport {
  const analyticalResults = results.filter((result) => evidenceAgents.has(result.agentId));
  const independent = analyticalResults.filter(
    (result) =>
      result.dataStatus === "live" &&
      result.evidence.length > 0 &&
      directionalAgentIds.includes(result.agentId) &&
      ["bullish", "bearish"].includes(result.stance),
  );
  const bullish = independent.filter((result) => result.stance === "bullish");
  const bearish = independent.filter((result) => result.stance === "bearish");
  const hasLiveCoinGecko = snapshot.sourceStatuses.some(
    (source) => source.source === "CoinGecko · USD" && source.status === "live",
  );
  const hasLiveBinance = snapshot.sourceStatuses.some(
    (source) => source.source === "Binance · USDT ticker" && source.status === "live",
  );
  const deviation = snapshot.sourceDeviationPercent;
  const sourcesConcordant =
    hasLiveCoinGecko &&
    hasLiveBinance &&
    deviation !== null &&
    deviation <= 1;
  const noDirectionalContradiction =
    bullish.length === 0 ||
    bearish.length === 0;
  const directionalConsensus =
    independent.length >= 2 &&
    noDirectionalContradiction &&
    sourcesConcordant &&
    riskScore !== null;
  const scoreFactors = calculateScoreFactors(
    weights,
    indicators,
    momentum,
    results.find((item) => item.agentId === "volume-analyst") ?? baseResult("volume-analyst"),
    riskScore,
    results,
    snapshot,
  );
  const scores = weightedScores(scoreFactors);
  const scoreForConsensus = bullish.length ? scores.longScore : scores.shortScore;
  let decision: FinalReport["decision"] = "no_clear_signal";
  if (directionalConsensus && scoreForConsensus !== null) {
    if (bullish.length && scoreForConsensus >= 72 && riskScore! < 40) decision = "strong_long";
    else if (bullish.length && scoreForConsensus >= 55) decision = "long";
    else if (bearish.length && scoreForConsensus >= 72 && riskScore! < 40) decision = "strong_short";
    else if (bearish.length && scoreForConsensus >= 55) decision = "short";
    else decision = "neutral_wait";
  }

  const liveEvidenceResults = analyticalResults.filter(
    (result) => result.dataStatus === "live" && result.evidence.length > 0,
  );
  const liveAgentCount = liveEvidenceResults.length;
  const totalAgentCount = analyticalResults.length;
  const coverageScore = totalAgentCount ? Math.round((liveAgentCount / totalAgentCount) * 100) : 0;
  const directionalCount = independent.length;
  const agreementScore =
    directionalCount < 2
      ? 0
      : Math.round(
          (Math.max(bullish.length, bearish.length) / directionalCount) * 100,
        );
  const sourceConsistencyScore =
    deviation === null || !hasLiveCoinGecko || !hasLiveBinance
      ? 0
      : Math.max(0, Math.round(100 - deviation * 40));
  const liveSources = new Set(
    analyticalResults.flatMap((result) =>
      result.dataSources
        .filter((source) => source.status === "live" && !source.source.includes("Gemini"))
        .map((source) => source.source),
    ),
  );
  let confidenceScore = Math.round(
    coverageScore * 0.45 + agreementScore * 0.35 + sourceConsistencyScore * 0.2,
  );
  if (liveAgentCount <= 2) confidenceScore = Math.min(confidenceScore, 25);
  else confidenceScore = Math.min(confidenceScore, coverageScore + 15);
  const confidenceLabel =
    confidenceScore < 25
      ? "Sehr niedrig · Datenbasis stark begrenzt"
      : confidenceScore < 50
        ? "Niedrig · Datenabdeckung begrenzt"
        : confidenceScore < 70
          ? "Begrenzt · Quellen nicht vollständig"
          : "Moderat · mehrere Quellen verfügbar";

  const mainReasons = independent.flatMap((result) =>
    result.stance === (bullish.length ? "bullish" : "bearish")
      ? result.bullishFactors.concat(result.bearishFactors).slice(0, 2)
      : [],
  );
  const counterArguments = [
    ...results
      .filter((result) => result.dataStatus === "live" && result.stance === (bullish.length ? "bearish" : "bullish"))
      .flatMap((result) => result.bearishFactors.concat(result.bullishFactors).slice(0, 2)),
    ...(deviation === null
      ? ["CoinGecko/Binance-Preisabweichung konnte nicht berechnet werden."]
      : deviation > 1
        ? [`CoinGecko und Binance weichen um ${deviation.toFixed(3)}% voneinander ab.`]
        : []),
    ...analyticalResults
      .filter((result) => result.dataStatus === "missing")
      .map((result) => `${result.displayName}: Datenquelle fehlt.`)
      .slice(0, 4),
  ];
  if (!mainReasons.length) mainReasons.push("Keine ausreichende Anzahl unabhängiger, live-datenbasierter Agents mit übereinstimmender Einordnung.");
  if (!counterArguments.length) counterArguments.push("Es wurde kein direkter Richtungswiderspruch gefunden; fehlende Agentenquellen bleiben jedoch ein Unsicherheitsfaktor.");

  const summary =
    decision === "no_clear_signal" || decision === "neutral_wait"
      ? "Keine klare Aussage / weiter beobachten. Für eine Einschätzung fehlen mehrere unabhängige, live-datenbasierte und übereinstimmende Agent-Ergebnisse."
      : `Datenbasierte technische Einordnung: ${decision.replaceAll("_", " ").toUpperCase()}. Keine Anlageberatung und keine Handelsanweisung.`;
  const invalidation =
    indicators.close !== null && indicators.ema50 !== null
      ? `Die aktuelle technische Einordnung wäre neu zu prüfen, wenn der Kurs die Tages-EMA 50 (${money(indicators.ema50)}) nachhaltig in Gegenrichtung durchbricht.`
      : "Keine belastbare Invalidierung ableitbar, da EMA 50 oder Schlusskurs fehlt.";
  const confidenceBreakdown: ConfidenceBreakdown = {
    coverageScore,
    agreementScore,
    sourceConsistencyScore,
    liveAgentCount,
    totalAgentCount,
    liveSourceCount: liveSources.size,
    totalSourceCount: new Set(analyticalResults.flatMap((result) => result.dataSources.map((source) => source.source))).size,
    methodology: "45% Live-Evidence-Abdeckung + 35% Übereinstimmung der datenbasierten Richtungs-Agents + 20% CoinGecko/Binance-Konsistenz; bei geringer Abdeckung zusätzlich begrenzt.",
  };
  return {
    decision,
    summary,
    confidenceScore,
    confidenceLabel,
    riskScore,
    mainReasons: [...new Set(mainReasons)].slice(0, 6),
    counterArguments: [...new Set(counterArguments)].slice(0, 8),
    invalidation,
    longScore: scores.longScore,
    shortScore: scores.shortScore,
    scoreFactors,
    confidenceBreakdown,
  };
}

function finalAgent(report: FinalReport): AgentResult {
  const stance: AgentResult["stance"] =
    report.decision.includes("long")
      ? "bullish"
      : report.decision.includes("short")
        ? "bearish"
        : report.decision === "neutral_wait"
          ? "neutral"
          : "not_evaluable";
  return baseResult("final-decision", {
    stance,
    summary: report.summary,
    confidence: report.confidenceScore,
    bullishFactors: report.decision.includes("long") ? report.mainReasons : [],
    bearishFactors: report.decision.includes("short") ? report.mainReasons : [],
    risks: report.counterArguments,
    rationale: `Risk Score: ${report.riskScore ?? "nicht bewertbar"}/100. ${report.invalidation}`,
    source: "Verified run outputs + weighted score",
    dataStatus: report.confidenceBreakdown.liveAgentCount > 0 ? "live" : "missing",
    dataSources: [],
  });
}

async function readRunResults(runId: string): Promise<AgentResult[]> {
  const rows = await db
    .select()
    .from(analysisAgentOutputs)
    .where(eq(analysisAgentOutputs.runId, runId));
  return rows.map((row) => ({
    agentId: row.agentId,
    displayName: agentById.get(row.agentId)?.displayName ?? row.agentId,
    status: row.status as AgentResult["status"],
    stance: row.stance as AgentResult["stance"],
    summary: row.summary,
    confidence: row.confidence,
    bullishFactors: row.bullishFactors,
    bearishFactors: row.bearishFactors,
    risks: row.risks,
    rationale: row.rationale,
    evidence: row.evidence,
    source: row.source,
    timestamp: row.timestamp.toISOString(),
    dataStatus: row.dataStatus as AgentResult["dataStatus"],
    dataSources: row.dataSources,
    error: row.error,
  }));
}

export async function executeAnalysisRun(input: {
  runId: string;
  accountId: string;
  question: string;
  asset: AssetCode;
}): Promise<void> {
  const controller = new AbortController();
  controllers.set(input.runId, controller);
  const { signal } = controller;
  const results = new Map<string, AgentResult>();
  try {
    await db
      .update(analysisRuns)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)));
    await addRunEvent(input.runId, input.accountId, "Master Agent", "Run gestartet; lade öffentliche Marktdaten.", "working");
    const snapshot = await getMarketSnapshot(input.asset);
    runWasStopped(signal);

    const market = calculateMarketStructure(snapshot);
    await executeAgent(input.runId, input.accountId, "market-structure", signal, () => ({ result: market, snapshot }), results);

    const technical = calculateTechnical(snapshot);
    await executeAgent(input.runId, input.accountId, "technical-analyst", signal, () => ({ result: technical.output, snapshot }), results);

    const momentum = calculateMomentum(snapshot);
    await executeAgent(input.runId, input.accountId, "momentum-scanner", signal, () => ({ result: momentum.output, snapshot }), results);

    const volume = calculateVolume(snapshot);
    await executeAgent(input.runId, input.accountId, "volume-analyst", signal, () => ({ result: volume, snapshot }), results);

    for (const [agentId, title] of [
      ["news-analyst", "News feeds"],
      ["macro-analyst", "macroeconomic data"],
      ["sentiment-analyst", "sentiment feeds"],
      ["social-sentiment", "social platforms"],
      ["on-chain-analyst", "on-chain data"],
    ]) {
      const output = unavailableAgent(
        agentId,
        title,
        `Keine ${title}-Datenquelle ist in dieser Version angebunden.`,
      );
      await executeAgent(input.runId, input.accountId, agentId, signal, () => ({ result: output, snapshot }), results);
    }

    const risk = calculateRisk(snapshot);
    await executeAgent(input.runId, input.accountId, "risk-analyst", signal, () => ({ result: risk.output, snapshot }), results);

    await executeAgent(
      input.runId,
      input.accountId,
      "market-scanner",
      signal,
      async () => ({
        result: await runMarketScanner(
          input.question,
          snapshot,
          [...results.values()],
          signal,
        ),
        snapshot,
      }),
      results,
    );

    await executeAgent(
      input.runId,
      input.accountId,
      "verification",
      signal,
      () => ({
        result: verifyResults([...results.values()], snapshot),
        snapshot: { market: snapshot, priorResults: [...results.values()] },
      }),
      results,
    );

    const settings = await getDeskSettings(input.accountId);
    const report = buildFinalReport(
      [...results.values()],
      snapshot,
      settings.scoreWeights,
      technical.indicators,
      momentum,
      risk.riskScore,
    );
    await executeAgent(
      input.runId,
      input.accountId,
      "final-decision",
      signal,
      () => ({ result: finalAgent(report), snapshot: { market: snapshot, report } }),
      results,
    );

    const master = baseResult("master", {
      stance: results.get("final-decision")?.stance ?? "not_evaluable",
      summary: `Analyse koordiniert. ${report.summary}`,
      confidence: report.confidenceScore,
      bullishFactors: report.decision.includes("long") ? report.mainReasons : [],
      bearishFactors: report.decision.includes("short") ? report.mainReasons : [],
      risks: report.counterArguments,
      rationale: "Ergebnisse werden nach Quellenqualität, Datenabdeckung, Widersprüchen und Risiko gewichtet; kein Mehrheitsentscheid.",
      evidence: [],
      source: "Server-side orchestration",
      dataStatus: report.confidenceBreakdown.liveAgentCount > 0 ? "live" : "missing",
      dataSources: snapshot.sourceStatuses,
    });
    await executeAgent(
      input.runId,
      input.accountId,
      "master",
      signal,
      () => ({ result: master, snapshot: { market: snapshot, report } }),
      results,
    );
    runWasStopped(signal);
    await db
      .update(analysisRuns)
      .set({
        status: "complete",
        updatedAt: new Date(),
        completedAt: new Date(),
        finalReport: toJsonObject(report),
        confidence: report.confidenceScore,
        error: null,
      })
      .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)));
    await addRunEvent(input.runId, input.accountId, "Master Agent", "Final Report erstellt.", "complete");
  } catch (error) {
    if (error instanceof RunStoppedError || signal.aborted) {
      await db
        .update(analysisRuns)
        .set({ status: "stopped", updatedAt: new Date(), completedAt: new Date() })
        .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)));
      await addRunEvent(input.runId, input.accountId, "Master Agent", "Run durch Nutzer gestoppt.", "info");
      return;
    }
    await db
      .update(analysisRuns)
      .set({
        status: "error",
        updatedAt: new Date(),
        completedAt: new Date(),
        error: "Run failed while reading or storing analysis data.",
      })
      .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)));
    await addRunEvent(input.runId, input.accountId, "Master Agent", "Run wegen eines technischen Fehlers beendet.", "error");
  } finally {
    controllers.delete(input.runId);
  }
}

export async function requestStopAnalysisRun(runId: string, accountId: string): Promise<boolean> {
  const [run] = await db
    .select({ status: analysisRuns.status })
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.accountId, accountId)))
    .limit(1);
  if (!run) return false;
  if (run.status === "queued" || run.status === "running") {
    controllers.get(runId)?.abort();
    await db
      .update(analysisRuns)
      .set({ status: "stopped", updatedAt: new Date(), completedAt: new Date() })
      .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.accountId, accountId)));
  }
  return true;
}

export async function getAnalysisRun(
  runId: string,
  accountId: string,
): Promise<AnalysisRun | null> {
  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.accountId, accountId)))
    .limit(1);
  if (!run) return null;
  const agentResults = await readRunResults(runId);
  return {
    runId: run.id,
    accountId: run.accountId,
    asset: run.asset as AssetCode,
    question: run.question,
    status: run.status as AnalysisRun["status"],
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    agentResults,
    activity: run.activity ?? [],
    finalReport: run.finalReport as FinalReport | null,
    error: run.error,
  };
}

export function getActiveRunCount(): number {
  return controllers.size;
}

export function getAgentDefinitions(): AgentDefinition[] {
  return agentDefinitions;
}

export function getAgentEvidenceSources(): string[] {
  return [...evidenceAgents];
}

export function asAgentEvidence(value: AgentEvidence): AgentEvidence {
  return value;
}
