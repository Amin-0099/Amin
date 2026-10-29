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
import { DEFAULT_SCORE_WEIGHTS, getDeskSettings } from "./account-settings";
import { generateGeminiContent, GeminiServiceError } from "./gemini";
import { getMarketSnapshot, type Candle, type MarketSnapshot } from "./market-data";
import {
  calculateMomentumIndicators,
  calculateTechnicalIndicators,
  type MomentumIndicators,
  type TechnicalIndicators,
} from "./technical-analysis";

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
  if (sources.length > 0 && sources.every((source) => source.status === "live")) return "live";
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

function standardDeviation(values: number[]): number | null {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  );
}

function evidenceTimestamp(status: DataSourceStatus, fallback: string): string {
  return status.observedAt ?? fallback;
}

function calculateTechnical(snapshot: MarketSnapshot): {
  output: AgentResult;
  indicators: TechnicalIndicators;
} {
  const candles = snapshot.dailyCandles;
  const indicators = calculateTechnicalIndicators(candles);
  const {
    close, ema20, ema50, ema200, sma20, sma50, rsi14, macd, macdSignal,
    macdHistogram, atr14, atrPercent, volatility20Percent, support20,
    resistance20, trend, breakout,
  } = indicators;
  const adequate = close !== null && ema20 !== null && ema50 !== null && rsi14 !== null && atr14 !== null;
  const sourceStatus = snapshot.dailyStatus;
  const stance = !adequate || sourceStatus.status !== "live"
    ? "not_evaluable"
      : trend === "bullish" && macdHistogram !== null && macdHistogram > 0 && rsi14 < 70
        ? "bullish"
        : trend === "bearish" && macdHistogram !== null && macdHistogram < 0 && rsi14 > 30
          ? "bearish"
          : "neutral";
  const measured: Array<[string, number | null, number]> = [
    ["Daily close", close, 2],
    ["EMA 20", ema20, 2],
    ["EMA 50", ema50, 2],
    ["EMA 200", ema200, 2],
    ["SMA 20", sma20, 2],
    ["SMA 50", sma50, 2],
    ["RSI 14", rsi14, 2],
    ["MACD line", macd, 6],
    ["MACD signal", macdSignal, 6],
    ["MACD histogram", macdHistogram, 6],
    ["ATR 14", atr14, 6],
    ["ATR 14 percent", atrPercent, 4],
    ["Realized volatility 20d", volatility20Percent, 4],
    ["20d support", support20, 2],
    ["20d resistance", resistance20, 2],
  ];
  const evidence = measured.flatMap(([metric, value, precision]) =>
    value === null
      ? []
      : [makeEvidence(
          metric,
          value.toFixed(precision),
          sourceStatus.source,
          evidenceTimestamp(sourceStatus, snapshot.generatedAt),
          sourceStatus.status,
        )],
  );
  if (trend !== "not_evaluable") {
    evidence.push(makeEvidence(
      "Trend",
      trend,
      sourceStatus.source,
      evidenceTimestamp(sourceStatus, snapshot.generatedAt),
      sourceStatus.status,
    ));
  }
  if (breakout !== null) {
    evidence.push(makeEvidence(
      "20d breakout",
      breakout,
      sourceStatus.source,
      evidenceTimestamp(sourceStatus, snapshot.generatedAt),
      sourceStatus.status,
    ));
  }
  const availableIndicators = measured.filter(([, value]) => value !== null).length;
  const indicatorCoverage = Math.round((availableIndicators / measured.length) * 100);
  const output = baseResult("technical-analyst", {
    stance,
    summary: !adequate
      ? "Nicht bewertbar: Für EMA, RSI und ATR liegen nicht genügend echte Tageskerzen vor."
      : sourceStatus.status !== "live"
        ? `Technische Kennzahlen berechnet, aber die Tageskerzen sind ${sourceStatus.status}; keine Richtungsbewertung.`
        : `${snapshot.asset} Tagestrend ${trend}; EMA20 ${money(ema20)}, EMA50 ${money(ema50)}, RSI14 ${rsi14.toFixed(1)}; MACD-Histogramm ${macdHistogram?.toFixed(6) ?? "nicht verfügbar"}.`,
    confidence: sourceStatus.status === "live" ? indicatorCoverage : 0,
    bullishFactors: adequate
      ? [
          ...(close! > ema20! ? [`Kurs liegt über EMA 20 (${money(ema20!)})`] : []),
          ...(ema200 !== null && close! > ema200 ? [`Kurs liegt über EMA 200 (${money(ema200)})`] : []),
          ...(macdHistogram !== null && macdHistogram > 0 ? ["MACD-Histogramm positiv"] : []),
        ]
      : [],
    bearishFactors: adequate
      ? [
          ...(close! < ema20! ? [`Kurs liegt unter EMA 20 (${money(ema20!)})`] : []),
          ...(ema200 !== null && close! < ema200 ? [`Kurs liegt unter EMA 200 (${money(ema200)})`] : []),
          ...(macdHistogram !== null && macdHistogram < 0 ? ["MACD-Histogramm negativ"] : []),
        ]
      : [],
    risks: adequate
      ? [
          ...(rsi14! >= 70 ? [`RSI 14 liegt bei ${rsi14!.toFixed(1)} (überkauft)`] : []),
          ...(rsi14! <= 30 ? [`RSI 14 liegt bei ${rsi14!.toFixed(1)} (überverkauft)`] : []),
          ...(ema200 === null ? ["Für EMA 200 sind weniger als 200 Tageskerzen vorhanden."] : []),
          ...(support20 === null || resistance20 === null ? ["Für 20-Tage-Unterstützung/Widerstand fehlen ausreichend Kerzen."] : []),
          ...(sourceStatus.status !== "live" ? [`Tageskerzen sind ${sourceStatus.status}; keine aktuelle Richtungsbewertung.`] : []),
        ]
      : ["Tageskerzen fehlen oder sind nicht frisch genug."],
    rationale: adequate
      ? "EMA/SMA, RSI, MACD, ATR, Volatilität und 20-Tage-Spanne werden ausschließlich aus abgeschlossenen Binance-Tageskerzen berechnet. Confidence ist hier Kennzahlen-Abdeckung, keine Trefferwahrscheinlichkeit."
      : "Die benötigten Eingangsdaten fehlen; es wird keine Richtung abgeleitet.",
    evidence,
    source: sourceStatus.source,
    dataStatus: adequate ? sourceStatus.status : "missing",
    dataSources: [sourceStatus],
  });
  return { output, indicators };
}

function calculateMomentum(snapshot: MarketSnapshot): {
  output: AgentResult;
  change6h: number | null;
  change24h: number | null;
  volumeChangePercent: number | null;
  volatilityPercent: number | null;
  rating: number | null;
  trend: MomentumIndicators["trend"];
} {
  const indicators = calculateMomentumIndicators(snapshot.hourlyCandles);
  const sourceStatus = snapshot.hourlyStatus;
  const adequate = indicators.rating !== null;
  const isLive = sourceStatus.status === "live";
  const stance: AgentResult["stance"] =
    !adequate || !isLive
      ? "not_evaluable"
      : indicators.rating! >= 65
        ? "bullish"
        : indicators.rating! <= 35
          ? "bearish"
          : "neutral";
  const evidence = [
    ["6h price change", indicators.change6h, 2],
    ["24h price change", indicators.change24h, 2],
    ["24h quote-volume change", indicators.volumeChangePercent, 1],
    ["Hourly volatility 24h", indicators.volatilityPercent, 4],
    ["Momentum rating", indicators.rating, 1],
  ].flatMap(([metric, value, precision]) =>
    typeof value === "number"
      ? [makeEvidence(
          String(metric),
          value.toFixed(Number(precision)),
          sourceStatus.source,
          evidenceTimestamp(sourceStatus, snapshot.generatedAt),
          sourceStatus.status,
        )]
      : [],
  );
  if (indicators.trend !== "not_evaluable") {
    evidence.push(makeEvidence(
      "Hourly trend",
      indicators.trend,
      sourceStatus.source,
      evidenceTimestamp(sourceStatus, snapshot.generatedAt),
      sourceStatus.status,
    ));
  }
  return {
    ...indicators,
    output: baseResult("momentum-scanner", {
      stance,
      summary: adequate && isLive
        ? `Momentum-Rating ${indicators.rating}/100 aus Preisbewegung, Volumenänderung, EMA-Trend und 24h-Volatilität.`
        : adequate
          ? `Momentum-Daten berechnet, Stundenkerzen aber ${sourceStatus.status}; keine Richtungsbewertung.`
        : "Nicht bewertbar: Für 6h- und 24h-Momentum fehlen abgeschlossene Stundenkerzen.",
      confidence: adequate && isLive ? Math.round((evidence.length / 6) * 100) : 0,
      bullishFactors: stance === "bullish" ? [`Momentum-Rating ${indicators.rating}/100`, `24h ${pct(indicators.change24h!)}`] : [],
      bearishFactors: stance === "bearish" ? [`Momentum-Rating ${indicators.rating}/100`, `24h ${pct(indicators.change24h!)}`] : [],
      risks: [
        ...(adequate && Math.sign(indicators.change6h!) !== Math.sign(indicators.change24h!)
          ? ["Kurzfristige und 24h-Preisbewegung widersprechen sich."]
          : []),
        ...(indicators.volumeChangePercent === null ? ["Vergleichbares 48h-Volumen fehlt."] : []),
        ...(!isLive ? [`Stundenkerzen sind ${sourceStatus.status}; Rating ist keine aktuelle Richtungsaussage.`] : []),
      ],
      rationale: adequate
        ? "Rating = 35% begrenzte 6h/24h-Preisbewegung + 25% 24h-Volumenänderung + 25% EMA20/50-Trend + 15% inverse 24h-Volatilität aus 24 abgeschlossenen Stundenrenditen; alle Komponenten stammen aus Binance-Stundenkerzen."
        : "Mindestens 25 abgeschlossene Stundenkerzen werden benötigt.",
      evidence,
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
          "Cross-source price deviation",
          `${deviation!.toFixed(3)}%`,
          "CoinGecko · USD + Binance · USDT ticker",
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
    confidence: evaluable ? Math.max(0, Math.round(100 - deviation! * 10)) : 0,
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
  const priceSource = snapshot.sourceStatuses.find(
    (source) =>
      ["Binance · USDT ticker", "CoinGecko · EUR"].includes(source.source) &&
      source.status === "live",
  );
  const stance =
    priceChange === null || sourceStatus.status !== "live"
      ? "not_evaluable"
      : change > 20 && priceChange > 0
        ? "bullish"
        : change > 20 && priceChange < 0
          ? "bearish"
          : "neutral";
  return baseResult("volume-analyst", {
    stance,
    summary: `Abgeschlossenes Stundenvolumen: ${change >= 0 ? "+" : ""}${change.toFixed(1)}% gegenüber den vorherigen 24h.`,
    confidence: sourceStatus.status === "live" ? (priceChange === null ? 67 : 100) : 0,
    bullishFactors: stance === "bullish" ? [`Volumen ${change.toFixed(1)}% höher bei positivem 24h-Preisverlauf.`] : [],
    bearishFactors: stance === "bearish" ? [`Volumen ${change.toFixed(1)}% höher bei negativem 24h-Preisverlauf.`] : [],
    risks: Math.abs(change) > 100 ? ["Ungewöhnlich starke Volumenänderung; Ausreißer oder Ereignis möglich."] : [],
    rationale: "Volumenänderung wird aus den letzten 24 gegenüber den vorherigen 24 abgeschlossenen Stundenkerzen berechnet.",
    evidence: [
      makeEvidence("24h quote-volume change", `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
      makeEvidence("Latest 24h quote volume (USDT)", last24.toFixed(2), sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
      ...(priceChange === null || !priceSource ? [] : [makeEvidence(
        "24h price change",
        priceChange.toFixed(2),
        priceSource.source,
        evidenceTimestamp(priceSource, snapshot.generatedAt),
        priceSource.status,
      )]),
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
  const dailyDeviation = standardDeviation(returns.slice(-30));
  const volatility = dailyDeviation === null ? null : dailyDeviation * Math.sqrt(365) * 100;
  let peak = 0;
  let maxDrawdown = 0;
  for (const close of closes.slice(-90)) {
    peak = Math.max(peak, close);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - close) / peak) * 100);
  }
  const deviation = snapshot.sourceDeviationPercent;
  const deviationSources = snapshot.sourceStatuses.filter((source) =>
    ["CoinGecko · USD", "Binance · USDT ticker"].includes(source.source),
  );
  const deviationObservedAt = deviationSources
    .map((source) => source.observedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? snapshot.generatedAt;
  const hasEnoughData = volatility !== null && closes.length >= 30;
  const sourceStatus = snapshot.dailyStatus;
  const isEvaluable = hasEnoughData && sourceStatus.status === "live";
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
  return {
    volatility,
    maxDrawdown: isEvaluable ? maxDrawdown : null,
    riskScore,
    output: baseResult("risk-analyst", {
      stance: isEvaluable ? "neutral" : "not_evaluable",
      summary: isEvaluable
        ? `Annualisierte 30-Tage-Volatilität ${volatility!.toFixed(1)}%, maximaler 90-Tage-Drawdown ${maxDrawdown.toFixed(1)}%; Risk Score ${riskScore}/100.`
        : hasEnoughData
          ? "Nicht bewertbar: Die Tageskerzen sind nicht frisch genug für eine aktuelle Risikobewertung."
          : "Nicht bewertbar: Für Volatilität und Drawdown liegen nicht genügend Tageskerzen vor.",
      confidence: isEvaluable ? Math.round((Math.min(closes.length, 90) / 90) * 100) : 0,
      bullishFactors: [],
      bearishFactors: [],
      risks: isEvaluable
        ? [
            `Annualisierte 30-Tage-Volatilität: ${volatility!.toFixed(1)}%.`,
            `Maximaler 90-Tage-Drawdown: ${maxDrawdown.toFixed(1)}%.`,
            ...(deviation === null ? ["CoinGecko/Binance-Abweichung fehlt."] : [`Quellenabweichung: ${deviation.toFixed(3)}%.`]),
          ]
        : [hasEnoughData ? "Risiko kann wegen veralteter Tageskerzen nicht aktuell berechnet werden." : "Risiko kann mangels ausreichender Tageskerzen nicht berechnet werden."],
      rationale: "Risk Score basiert auf annualisierter Volatilität, maximalem 90-Tage-Drawdown und der Preisabweichung öffentlicher Quellen.",
      evidence: isEvaluable
        ? [
            makeEvidence("Annualized volatility, 30d", `${volatility!.toFixed(2)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
            makeEvidence("Maximum drawdown, 90d", `${maxDrawdown.toFixed(2)}%`, sourceStatus.source, evidenceTimestamp(sourceStatus, snapshot.generatedAt), sourceStatus.status),
            ...(deviation === null ? [] : [makeEvidence(
              "Source deviation",
              `${deviation.toFixed(3)}%`,
              "CoinGecko · USD + Binance · USDT ticker",
              deviationObservedAt,
              "live",
            )]),
          ]
        : [],
      source: sourceStatus.source,
      dataStatus: hasEnoughData ? sourceStatus.status : "missing",
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
      bullishFactors: { type: "ARRAY", items: { type: "STRING" } },
      bearishFactors: { type: "ARRAY", items: { type: "STRING" } },
      risks: { type: "ARRAY", items: { type: "STRING" } },
      rationale: { type: "STRING" },
      evidenceIds: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: [
      "stance",
      "summary",
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
    confidence: evidence.length
      ? Math.round((evidence.filter((item) => item.dataStatus === "live").length / evidence.length) * 100)
      : 0,
    bullishFactors: stance === "bullish" ? parsed.bullishFactors : [],
    bearishFactors: stance === "bearish" ? parsed.bearishFactors : [],
    risks: parsed.risks,
    rationale: parsed.rationale,
    evidence,
    source: geminiStatus.source,
    dataStatus: hasLiveMarketEvidence
      ? "live"
      : evidence.some((item) => item.dataStatus === "stale")
        ? "stale"
        : "missing",
    dataSources: [geminiStatus, ...marketStatuses],
  });
}

export function verifyResults(results: AgentResult[], snapshot: MarketSnapshot): AgentResult {
  const sourceRows = snapshot.sourceStatuses;
  const sourceNames = new Set(sourceRows.map((source) => source.source));
  const findings: string[] = [];
  let checkedEvidence = 0;
  let verifiedEvidence = 0;
  let unverifiableEvidence = 0;
  const technical = calculateTechnicalIndicators(snapshot.dailyCandles);
  const momentum = calculateMomentumIndicators(snapshot.hourlyCandles);
  const dailyCloses = snapshot.dailyCandles.map((candle) => candle.close).filter((value) => value > 0);
  const dailyReturns = dailyCloses.slice(1).map((close, index) => Math.log(close / dailyCloses[index]));
  const dailyVolatility = standardDeviation(dailyReturns.slice(-30));
  const maxDrawdown90d = (() => {
    let peak = 0;
    let drawdown = 0;
    for (const close of dailyCloses.slice(-90)) {
      peak = Math.max(peak, close);
      if (peak > 0) drawdown = Math.max(drawdown, ((peak - close) / peak) * 100);
    }
    return drawdown;
  })();
  const last24Volume = snapshot.hourlyCandles.slice(-24)
    .reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const previous24Volume = snapshot.hourlyCandles.slice(-48, -24)
    .reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const volumeChange = previous24Volume > 0
    ? ((last24Volume - previous24Volume) / previous24Volume) * 100
    : null;
  const rawMetrics: Record<string, number | string | null> = {
    "Daily close": technical.close,
    "EMA 20": technical.ema20,
    "EMA 50": technical.ema50,
    "EMA 200": technical.ema200,
    "SMA 20": technical.sma20,
    "SMA 50": technical.sma50,
    "RSI 14": technical.rsi14,
    "MACD line": technical.macd,
    "MACD signal": technical.macdSignal,
    "MACD histogram": technical.macdHistogram,
    "ATR 14": technical.atr14,
    "ATR 14 percent": technical.atrPercent,
    "Realized volatility 20d": technical.volatility20Percent,
    "20d support": technical.support20,
    "20d resistance": technical.resistance20,
    "20d breakout": technical.breakout,
    "Annualized volatility, 30d": dailyVolatility === null
      ? null
      : dailyVolatility * Math.sqrt(365) * 100,
    "Maximum drawdown, 90d": dailyCloses.length >= 30 ? maxDrawdown90d : null,
    Trend: technical.trend === "not_evaluable" ? null : technical.trend,
    "6h price change": momentum.change6h,
    "24h price change": snapshot.change24hPercent,
    "24h quote-volume change": volumeChange,
    "Latest 24h quote volume (USDT)": snapshot.hourlyCandles.length >= 24 ? last24Volume : null,
    "Hourly volatility 24h": momentum.volatilityPercent,
    "Momentum rating": momentum.rating,
    "Hourly trend": momentum.trend === "not_evaluable" ? null : momentum.trend,
    "Cross-source price deviation": snapshot.sourceDeviationPercent,
    "Source deviation": snapshot.sourceDeviationPercent,
    "24h change": snapshot.change24hPercent,
  };
  const numberFromEvidence = (value: string): number | null => {
    const normalized = value.replaceAll(",", "").replace(/[€%+\s]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const evidenceSources = (sourceName: string): DataSourceStatus[] => {
    if (sourceName === "CoinGecko · USD + Binance · USDT ticker") {
      return sourceRows.filter((source) =>
        ["CoinGecko · USD", "Binance · USDT ticker"].includes(source.source),
      );
    }
    return sourceRows.filter((source) => source.source === sourceName);
  };
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
      let verified = true;
      if (item.dataStatus === "missing") {
        verified = false;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ ist als fehlend markiert.`);
      }
      const evidenceStatusSources = evidenceSources(item.source);
      if (!sourceNames.has(item.source) && evidenceStatusSources.length === 0) {
        verified = false;
        findings.push(`${result.displayName}: Quelle „${item.source}“ ist nicht im aktuellen Quellenstatus enthalten.`);
      }
      if (!Number.isFinite(Date.parse(item.timestamp))) {
        verified = false;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ hat keinen gültigen ISO-Zeitstempel.`);
      }
      const expected = rawMetrics[item.metric];
      if (expected === null || expected === undefined) {
        unverifiableEvidence += 1;
        verified = false;
        findings.push(`${result.displayName}: Aussage „${item.metric}“ kann nicht aus dem gespeicherten Rohdaten-Snapshot geprüft werden.`);
      } else if (typeof expected === "number") {
        const observed = numberFromEvidence(item.value);
        const decimalDigits = item.value.replaceAll(",", "").match(/\.(\d+)/)?.[1].length ?? 0;
        const tolerance = Math.max(
          0.5 * (10 ** -decimalDigits),
          Math.abs(expected) * Number.EPSILON * 10,
        );
        if (observed === null || Math.abs(observed - expected) > tolerance) {
          verified = false;
          findings.push(`${result.displayName}: Beleg „${item.metric}“ stimmt nicht mit dem Rohdaten-Snapshot überein.`);
        }
      } else if (item.value !== expected) {
        verified = false;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ stimmt nicht mit dem Rohdaten-Snapshot überein.`);
      }
      if (
        item.dataStatus === "live" &&
        (evidenceStatusSources.length === 0 ||
          evidenceStatusSources.some((source) => source.status !== "live"))
      ) {
        verified = false;
        findings.push(`${result.displayName}: Beleg „${item.metric}“ ist als live markiert, obwohl mindestens eine Rohdatenquelle stale oder missing ist.`);
      }
      if (
        item.dataStatus === "live" &&
        evidenceStatusSources.length > 0 &&
        !evidenceStatusSources.some((source) => source.observedAt === item.timestamp)
      ) {
        verified = false;
        findings.push(`${result.displayName}: Zeitstempel von „${item.metric}“ passt nicht zum Quellenzeitstempel.`);
      }
      if (verified) verifiedEvidence += 1;
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
  if (results.some((result) => result.agentId === "market-scanner" && result.evidence.length > 0)) {
    findings.push("LLM-Zusammenfassungen sind Interpretation und keine unabhängig verifizierten Marktfakten.");
  }
  if (!findings.length) findings.push("Alle vorliegenden Belege haben einen Zeitstempel und eine verfügbare Quellenzuordnung.");
  const status = results.some((result) => result.evidence.length > 0)
    ? aggregateDataStatus(sourceRows)
    : "missing";
  return baseResult("verification", {
    stance: hasBull && hasBear ? "neutral" : "not_evaluable",
    summary: `${checkedEvidence} Belege gegen Rohdaten geprüft; ${verifiedEvidence} bestätigt, ${unverifiableEvidence} nicht mechanisch prüfbar.`,
    confidence: checkedEvidence ? Math.round((verifiedEvidence / checkedEvidence) * 100) : 0,
    bullishFactors: [],
    bearishFactors: [],
    risks: findings,
    rationale: "Kennzahlen werden erneut aus den gespeicherten Candle-Rohdaten berechnet; Quelle, Zeitstempel, Freshness, Status und angegebener Wert werden separat geprüft.",
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
  const available = factors.filter(
    (factor) =>
      factor.name !== "risk" &&
      factor.value !== null &&
      factor.weight > 0 &&
      factor.dataStatus === "live",
  );
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
    riskScore !== null &&
    (results.find((result) => result.agentId === "verification")?.confidence ?? 0) >= 70;
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

  const confidenceResults = analyticalResults.filter((result) => result.agentId !== "market-scanner");
  const liveEvidenceResults = confidenceResults.filter(
    (result) => result.dataStatus === "live" && result.evidence.length > 0,
  );
  const liveAgentCount = liveEvidenceResults.length;
  const totalAgentCount = confidenceResults.length;
  const coverageScore = totalAgentCount ? Math.round((liveAgentCount / totalAgentCount) * 100) : 0;
  const observedSources = new Map(
    snapshot.sourceStatuses.map((source) => [source.source, source.status]),
  );
  const freshnessScore = observedSources.size
    ? Math.round(
        ([...observedSources.values()].filter((status) => status === "live").length /
          observedSources.size) *
          100,
      )
    : 0;
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
  const contradictionCount = bullish.length * bearish.length;
  const verificationScore = results.find((result) => result.agentId === "verification")?.confidence ?? 0;
  const liveSources = new Set(
    analyticalResults.flatMap((result) =>
      result.dataSources
        .filter((source) => source.status === "live" && !source.source.includes("Gemini"))
        .map((source) => source.source),
    ),
  );
  const confidenceScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        coverageScore * 0.25 +
          freshnessScore * 0.2 +
          agreementScore * 0.2 +
          sourceConsistencyScore * 0.2 +
          verificationScore * 0.15 -
          contradictionCount * 10,
      ),
    ),
  );
  const confidenceLabel =
    confidenceScore < 25
      ? "Sehr niedrig · Datenbasis stark begrenzt, keine Trefferwahrscheinlichkeit"
      : confidenceScore < 50
        ? "Niedrig · Datenabdeckung begrenzt, keine Trefferwahrscheinlichkeit"
        : confidenceScore < 70
          ? "Begrenzt · Quellen nicht vollständig, keine Trefferwahrscheinlichkeit"
          : "Moderat · mehrere Quellen verfügbar, keine Trefferwahrscheinlichkeit";

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
    ...(results.find((result) => result.agentId === "verification")?.risks ?? []).slice(0, 4),
  ];
  if (!mainReasons.length) mainReasons.push("Keine ausreichende Anzahl unabhängiger, live-datenbasierter Agents mit übereinstimmender Einordnung.");
  if (!counterArguments.length) counterArguments.push("Es wurde kein direkter Richtungswiderspruch gefunden; fehlende Agentenquellen bleiben jedoch ein Unsicherheitsfaktor.");

  const summary =
    decision === "no_clear_signal" || decision === "neutral_wait"
      ? "Keine klare Aussage / weiter beobachten. Für eine Einschätzung fehlen mehrere unabhängige, live-datenbasierte und übereinstimmende Agent-Ergebnisse."
      : `Datenbasierte technische Einordnung: ${decision.replaceAll("_", " ").toUpperCase()}. Keine Anlageberatung und keine Handelsanweisung.`;
  const invalidation =
    indicators.close !== null && indicators.ema50 !== null
      ? `Kauf-Idee stimmt nicht mehr unter der Tages-EMA 50 (${money(indicators.ema50)}), sofern ein abgeschlossener Tageskurs darunter liegt.`
      : "Kauf-Idee stimmt nicht mehr unter dem letzten bestätigten Tages-Schlusskurs; eine belastbare Schwelle fehlt, da EMA 50 oder Kerzen fehlen.";
  const confidenceBreakdown: ConfidenceBreakdown = {
    coverageScore,
    freshnessScore,
    agreementScore,
    sourceConsistencyScore,
    verificationScore,
    confirmationCount: independent.length,
    contradictionCount,
    liveAgentCount,
    totalAgentCount,
    liveSourceCount: liveSources.size,
    totalSourceCount: new Set(analyticalResults.flatMap((result) => result.dataSources.map((source) => source.source))).size,
    methodology: "Qualitätsindex, keine Trefferwahrscheinlichkeit: 25% Live-Evidence-Abdeckung + 20% Frische + 20% Richtungsübereinstimmung + 20% Quellenkonsistenz + 15% Rohdaten-Verifikation minus 10 Punkte je gegensätzlichem Agentenpaar. Gemini-Aussagen zählen nicht als Rohdaten-Evidence.",
  };
  const stance: FinalReport["stance"] = decision.includes("long")
    ? "bullish"
    : decision.includes("short")
      ? "bearish"
      : decision === "neutral_wait"
        ? "neutral"
        : "not_evaluable";
  const radarState: FinalReport["radarState"] =
    (decision === "long" || decision === "strong_long") &&
    confidenceScore >= 50 &&
    riskScore !== null &&
    riskScore < 60
      ? "attractive_risk_reward"
      : decision === "no_clear_signal" || decision === "short" || decision === "strong_short"
        ? "stand_aside"
        : "observe";
  const evidence = [...new Map(
    analyticalResults.flatMap((result) =>
      result.evidence.map((item) => [`${item.metric}:${item.source}:${item.timestamp}`, item] as const),
    ),
  ).values()];
  return {
    stance,
    radarState,
    generatedAt: snapshot.generatedAt,
    dataStatus: aggregateDataStatus(snapshot.sourceStatuses),
    currentData: {
      asset: snapshot.asset,
      priceEur: snapshot.priceEur,
      priceUsd: snapshot.priceUsd,
      change24hPercent: snapshot.change24hPercent,
      change7dPercent: snapshot.change7dPercent,
      volume24hEur: snapshot.volume24hEur,
      marketCapEur: snapshot.marketCapEur,
      sourceDeviationPercent: snapshot.sourceDeviationPercent,
      hourlyCandleAt: snapshot.hourlyStatus.observedAt,
      dailyCandleAt: snapshot.dailyStatus.observedAt,
      sourceStatuses: snapshot.sourceStatuses,
    },
    evidence,
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

export function analyzeMarketSnapshot(
  snapshot: MarketSnapshot,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
) {
  const market = calculateMarketStructure(snapshot);
  const technical = calculateTechnical(snapshot);
  const momentum = calculateMomentum(snapshot);
  const volume = calculateVolume(snapshot);
  const unavailableSources: Array<[string, string]> = [
    ["news-analyst", "News feeds"],
    ["macro-analyst", "macroeconomic data"],
    ["sentiment-analyst", "sentiment feeds"],
    ["social-sentiment", "social platforms"],
    ["on-chain-analyst", "on-chain data"],
  ];
  const unavailable = unavailableSources.map(([agentId, title]) =>
    unavailableAgent(
      agentId,
      title,
      `Keine ${title}-Datenquelle ist in dieser Version angebunden.`,
    ),
  );
  const risk = calculateRisk(snapshot);
  const agentResults = [
    market,
    technical.output,
    momentum.output,
    volume,
    ...unavailable,
    risk.output,
  ];
  const verification = verifyResults(agentResults, snapshot);
  const report = buildFinalReport(
    [...agentResults, verification],
    snapshot,
    weights,
    technical.indicators,
    momentum,
    risk.riskScore,
  );

  return {
    agentResults,
    verification,
    report,
    indicators: technical.indicators,
    momentum,
    riskScore: risk.riskScore,
  };
}

function finalAgent(report: FinalReport): AgentResult {
  return baseResult("final-decision", {
    stance: report.stance,
    summary: report.summary,
    confidence: report.confidenceScore,
    bullishFactors: report.decision.includes("long") ? report.mainReasons : [],
    bearishFactors: report.decision.includes("short") ? report.mainReasons : [],
    risks: report.counterArguments,
    rationale: `Risk Score: ${report.riskScore ?? "nicht bewertbar"}/100. ${report.invalidation}`,
    evidence: report.evidence,
    source: "Verified run outputs + weighted score",
    dataStatus: report.dataStatus,
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
    const snapshot = await getMarketSnapshot(input.asset, true);
    runWasStopped(signal);
    const settings = await getDeskSettings(input.accountId);
    const analysis = analyzeMarketSnapshot(snapshot, settings.scoreWeights);
    for (const result of analysis.agentResults) {
      await executeAgent(
        input.runId,
        input.accountId,
        result.agentId,
        signal,
        () => ({ result, snapshot }),
        results,
      );
    }

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

    const report = buildFinalReport(
      [...results.values()],
      snapshot,
      settings.scoreWeights,
      analysis.indicators,
      analysis.momentum,
      analysis.riskScore,
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
      dataStatus: report.dataStatus,
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
