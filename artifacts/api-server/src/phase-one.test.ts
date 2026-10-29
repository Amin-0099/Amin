import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import type { ScoreWeights } from "@workspace/api-zod";
import type { Candle, MarketSnapshot } from "./lib/market-data";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const databaseIntegrationEnabled = process.env.PHASE2_DATABASE_TEST === "1";

const [
  { default: apiRouter },
  { analyzeMarketSnapshot, buildFinalReport, verifyResults },
  { computeRadarScore, getMarketSnapshot, getRadarAssets, haveContinuousCandles, parseCandles },
  { calculatePaperFee, calculatePaperPerformance, calculateTradePnl, getPaperPriceDataStatus, hasActionablePaperSignal, resolvePaperCloseReason },
  { calculateMomentumIndicators, calculateTechnicalIndicators, relativeStrengthIndex },
  { calculateRadarErrorSources, calculateRadarPerformance, copySignalSnapshot, evaluateSignalOutcomes },
] = await Promise.all([
    import("./routes"),
    import("./lib/analysis-engine"),
    import("./lib/market-data"),
    import("./lib/paper-service"),
    import("./lib/technical-analysis"),
    import("./lib/radar-evaluation"),
  ]);

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

let server: Server;
let baseUrl: string;

function makeKlineRows(
  count: number,
  intervalMs: number,
  increasedVolumeFrom = count,
  startingPrice = 100,
  priceStep = 0.2,
): unknown[][] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const close = startingPrice + index * priceStep;
    const open = close - 0.02;
    const volume = index >= increasedVolumeFrom ? 130 : 100;
    const openTime = now - (count - index) * intervalMs;
    return [
      openTime,
      open.toString(),
      (close + 0.1).toString(),
      (open - 0.1).toString(),
      close.toString(),
      (volume / close).toString(),
      openTime + intervalMs - 1,
      volume.toString(),
    ];
  });
}

before(async () => {
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (databaseIntegrationEnabled) {
    const { pool } = await import("@workspace/db");
    await pool.end();
  }
});

test("health route returns its registered status", async () => {
  const response = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("market scanner rejects an empty request before any Gemini call", async () => {
  const response = await fetch(`${baseUrl}/api/market-scanner/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "INVALID_QUESTION");
});

test("analysis and history routes reject invalid inputs before database access", async () => {
  const start = await fetch(`${baseUrl}/api/analysis/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(start.status, 400);

  const history = await fetch(`${baseUrl}/api/analysis/history?accountId=invalid`);
  assert.equal(history.status, 400);
});

test("paper and settings routes reject invalid account data before database access", async () => {
  const portfolio = await fetch(`${baseUrl}/api/paper/portfolio?accountId=invalid`);
  assert.equal(portfolio.status, 400);
  const performance = await fetch(`${baseUrl}/api/paper/performance?accountId=invalid`);
  assert.equal(performance.status, 400);

  const settings = await fetch(`${baseUrl}/api/settings?accountId=invalid`);
  assert.equal(settings.status, 400);

  const openTrade = await fetch(`${baseUrl}/api/paper/trades`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(openTrade.status, 400);

  const duplicateReference = await fetch(`${baseUrl}/api/paper/trades`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: randomUUID(),
      runId: randomUUID(),
      signalId: randomUUID(),
      side: "long",
      sizeEur: 100,
      stopLossEur: null,
      takeProfitEur: null,
      feeRateBps: 10,
    }),
  });
  assert.equal(duplicateReference.status, 400);
  assert.equal((await duplicateReference.json() as { code: string }).code, "INVALID_SIGNAL_REFERENCE");
});

test("radar score requires complete data and returns a deterministic score", () => {
  assert.equal(computeRadarScore(0, 100, 10_000), 51);
  assert.equal(computeRadarScore(null, 100, 10_000), null);
  assert.equal(computeRadarScore(1, 100, 0), null);
  assert.equal(computeRadarScore(Number.NaN, 100, 10_000), null);
});

test("market data prefers a fresh Binance EUR-converted quote", async () => {
  const originalFetch = globalThis.fetch;
  const checkedAt = Date.now();
  const observedAt = new Date(checkedAt).toISOString();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("vs_currency=eur")) {
      return Response.json([{
        id: "bitcoin",
        current_price: 40_000,
        market_cap: 1_000_000_000,
        total_volume: 2_000_000,
        price_change_percentage_24h: 1,
        price_change_percentage_7d_in_currency: 3,
        last_updated: observedAt,
        sparkline_in_7d: { price: [39_000, 40_000] },
      }]);
    }
    if (url.includes("vs_currency=usd")) {
      return Response.json([{
        id: "bitcoin",
        current_price: 43_200,
        last_updated: observedAt,
      }]);
    }
    if (url.includes("binance.com") && url.includes("ticker/24hr")) {
      return Response.json([
        { symbol: "BTCUSDT", lastPrice: "43000", priceChangePercent: "2", quoteVolume: "1080", closeTime: checkedAt },
        { symbol: "EURUSDT", lastPrice: "1.08", priceChangePercent: "0", quoteVolume: "1", closeTime: checkedAt },
      ]);
    }
    return Response.json([]);
  };

  try {
    const assets = await getRadarAssets(true);
    const bitcoin = assets.find((asset) => asset.symbol === "BTC");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "live");
    assert.equal(bitcoin.priceEur, 43_000 / 1.08);
    assert.equal(bitcoin.change24hPercent, 2);
    assert.ok(Math.abs((bitcoin.volume24hEur ?? 0) - 1_000) < 1e-9);
    assert.ok(bitcoin.radarScore !== null);
    assert.equal(bitcoin.sourceStatuses.find((source) => source.source === "Binance · USDT ticker")?.observedAt, observedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market data falls back to fresh CoinGecko fields when Binance fields are invalid", async () => {
  const originalFetch = globalThis.fetch;
  const closeTime = Date.now() - 1_000;
  const observedAt = new Date(closeTime).toISOString();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("vs_currency=eur")) {
      return Response.json([{
        id: "bitcoin",
        current_price: 100,
        market_cap: 10_000,
        total_volume: 1_000,
        price_change_percentage_24h: 1.5,
        last_updated: observedAt,
      }]);
    }
    if (url.includes("vs_currency=usd")) return Response.json([]);
    if (url.includes("binance.com") && url.includes("ticker/24hr")) {
      return Response.json([
        { symbol: "BTCUSDT", lastPrice: "108", priceChangePercent: null, quoteVolume: "", closeTime },
        { symbol: "EURUSDT", lastPrice: "1.08", priceChangePercent: "0", quoteVolume: "1", closeTime },
      ]);
    }
    return Response.json([]);
  };

  try {
    const assets = await getRadarAssets(true);
    const bitcoin = assets.find((asset) => asset.symbol === "BTC");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "live");
    assert.equal(bitcoin.change24hPercent, 1.5);
    assert.equal(bitcoin.volume24hEur, 1_000);
    assert.ok(bitcoin.radarScore !== null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid and stale market values never create a live radar score", async () => {
  const originalFetch = globalThis.fetch;
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("vs_currency=eur")) {
      return Response.json([{
        id: "bitcoin",
        current_price: null,
        market_cap: null,
        total_volume: null,
        price_change_percentage_24h: null,
        last_updated: new Date().toISOString(),
      }]);
    }
    if (url.includes("vs_currency=usd")) {
      return Response.json([{
        id: "bitcoin",
        current_price: 43_000,
        last_updated: staleAt,
      }]);
    }
    if (url.includes("binance.com") && url.includes("ticker/24hr")) {
      return Response.json([
        { symbol: "BTCUSDT", lastPrice: "43000", priceChangePercent: "2", quoteVolume: "1080", closeTime: Date.parse(staleAt) },
        { symbol: "EURUSDT", lastPrice: "1.08", priceChangePercent: "0", quoteVolume: "1", closeTime: Date.parse(staleAt) },
      ]);
    }
    return Response.json([]);
  };

  try {
    const assets = await getRadarAssets(true);
    const bitcoin = assets.find((asset) => asset.symbol === "BTC");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "stale");
    assert.ok(bitcoin.priceEur !== null);
    assert.equal(bitcoin.change24hPercent, null);
    assert.equal(bitcoin.radarScore, null);
    assert.equal(bitcoin.sourceStatuses.find((source) => source.source === "Binance · USDT ticker")?.status, "stale");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rate-limited providers are reported as missing without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 429 });

  try {
    const assets = await getRadarAssets(true);
    const bitcoin = assets.find((asset) => asset.symbol === "BTC");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "missing");
    assert.equal(bitcoin.priceEur, null);
    assert.ok(bitcoin.sourceStatuses.some((source) => source.detail.includes("rate limit reached")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candle parser rejects nulls and inconsistent OHLC values", () => {
  const now = Date.now();
  assert.deepEqual(parseCandles([
    [now - 120_000, "", "10", "9", "9.5", "1", now - 60_000, "9.5"],
    [now - 120_000, "10", "9", "11", "10.5", "1", now - 60_000, "10.5"],
  ]), []);
});

test("candle parser sorts rows and deduplicates repeated open timestamps", () => {
  const rows = makeKlineRows(3, 60_000);
  const parsed = parseCandles([rows[2], rows[0], rows[0], rows[1]]);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((candle) => candle.openTime), [
    parsed[0].openTime,
    parsed[1].openTime,
    parsed[2].openTime,
  ]);
  assert.ok(parsed[0].openTime < parsed[1].openTime);
  assert.ok(parsed[1].openTime < parsed[2].openTime);
});

test("candle continuity rejects gaps and malformed period boundaries", () => {
  const candles = parseCandles(makeKlineRows(4, 60 * 60 * 1_000));
  assert.equal(haveContinuousCandles(candles, "1h"), true);
  assert.equal(haveContinuousCandles([candles[0], candles[2], candles[3]], "1h"), false);
  assert.equal(
    haveContinuousCandles([{ ...candles[0], closeTime: candles[0].openTime + 60 * 60 * 1_000 }], "1h"),
    false,
  );
  assert.equal(haveContinuousCandles(candles, "1d"), false);
});

test("technical indicators use raw candle series and handle insufficient or flat data", () => {
  const rising = parseCandles(makeKlineRows(220, 24 * 60 * 60 * 1_000));
  const indicators = calculateTechnicalIndicators(rising);
  assert.ok(indicators.ema20 !== null);
  assert.ok(indicators.ema50 !== null);
  assert.ok(indicators.ema200 !== null);
  assert.ok(indicators.sma20 !== null);
  assert.ok(indicators.sma50 !== null);
  assert.ok(indicators.rsi14 !== null && indicators.rsi14 > 99);
  assert.ok(indicators.macd !== null);
  assert.ok(indicators.macdSignal !== null);
  assert.ok(indicators.macdHistogram !== null);
  assert.ok(indicators.atr14 !== null && indicators.atr14 > 0);
  assert.ok(indicators.support20 !== null && indicators.resistance20 !== null);
  assert.equal(indicators.trend, "bullish");
  assert.equal(calculateTechnicalIndicators([]).rsi14, null);
  assert.equal(relativeStrengthIndex(Array(30).fill(100)), 50);
  assert.equal(relativeStrengthIndex([1, 2, 3], 14), null);
});

test("momentum rating combines price, volume, trend, and volatility from candles", () => {
  const rising = parseCandles(makeKlineRows(60, 60 * 60 * 1_000, 30));
  const falling = parseCandles(makeKlineRows(60, 60 * 60 * 1_000, 30, 200, -0.2));
  const bullish = calculateMomentumIndicators(rising);
  const bearish = calculateMomentumIndicators(falling);
  assert.ok(bullish.rating !== null && bullish.rating > 65);
  assert.ok(bullish.volumeChangePercent !== null && bullish.volumeChangePercent > 0);
  assert.equal(bullish.trend, "bullish");
  assert.ok(bearish.rating !== null && bearish.rating < 50);
  assert.equal(bearish.trend, "bearish");
  assert.equal(calculateMomentumIndicators(rising.slice(0, 24)).rating, null);
});

test("verification detects evidence values that cannot be reproduced from candles", () => {
  const checkedAt = new Date().toISOString();
  const candles = parseCandles(makeKlineRows(220, 24 * 60 * 60 * 1_000));
  const missingSource = {
    source: "Binance · 1d candles",
    status: "live",
    checkedAt,
    observedAt: new Date(candles.at(-1)!.closeTime).toISOString(),
    ageMinutes: 0,
    detail: "Test candle source.",
  } as const;
  const snapshot = {
    asset: "BTC",
    generatedAt: checkedAt,
    priceEur: null,
    priceEurObserved: null,
    priceUsd: null,
    change24hPercent: null,
    change7dPercent: null,
    volume24hEur: null,
    marketCapEur: null,
    sourceStatuses: [missingSource],
    hourlyCandles: [],
    dailyCandles: candles,
    hourlyStatus: { ...missingSource, source: "Binance · 1h candles", status: "missing" as const, observedAt: null },
    dailyStatus: missingSource,
    sourceDeviationPercent: null,
  } satisfies MarketSnapshot;
  const original = analyzeMarketSnapshot(snapshot).agentResults;
  const corrupted = original.map((result) =>
    result.agentId === "technical-analyst"
      ? {
          ...result,
          evidence: result.evidence.map((item) =>
            item.metric === "EMA 20" ? { ...item, value: "999999.00" } : item,
          ),
        }
      : result,
  );
  const verification = verifyResults(corrupted, snapshot);
  assert.ok(verification.risks.some((risk) => risk.includes("EMA 20") && risk.includes("Rohdaten-Snapshot")));
  assert.ok(verification.confidence < 100);
});

test("radar evaluation reports measured performance by asset, signal, and horizon", () => {
  const performance = calculateRadarPerformance([
    { asset: "BTC", signalType: "long", stance: "bullish", horizonHours: 24, returnPercent: 2, directionCorrect: true },
    { asset: "BTC", signalType: "long", stance: "bullish", horizonHours: 24, returnPercent: -1, directionCorrect: false },
    { asset: "ETH", signalType: "neutral_wait", stance: "neutral", horizonHours: 24, returnPercent: 0.5, directionCorrect: null },
  ]);
  assert.deepEqual(performance, [
    {
      asset: "BTC",
      signalType: "long",
      stance: "bullish",
      horizonHours: 24,
      sampleCount: 2,
      status: "insufficient_data",
      directionalSampleCount: 2,
      hits: 1,
      hitRatePercent: null,
      averageReturnPercent: null,
    },
    {
      asset: "ETH",
      signalType: "neutral_wait",
      stance: "neutral",
      horizonHours: 24,
      sampleCount: 1,
      status: "insufficient_data",
      directionalSampleCount: 0,
      hits: 0,
      hitRatePercent: null,
      averageReturnPercent: null,
    },
  ]);
});

test("radar evaluation classifies stored data and signal errors", () => {
  const errors = calculateRadarErrorSources([
    {
      currentData: {
        sourceStatuses: [{ status: "missing" }, { status: "stale" }],
        sourceDeviationPercent: 1.5,
      },
      counterArguments: ["Evidence does not match the Rohdaten-Snapshot."],
      confidenceBreakdown: { contradictionCount: 1 },
    },
    {
      currentData: {
        sourceStatuses: [{ status: "stale" }],
        sourceDeviationPercent: 0.1,
      },
      counterArguments: [],
      confidenceBreakdown: { contradictionCount: 0 },
    },
  ]);
  assert.deepEqual(errors, [
    { category: "missing_data", signalCount: 1 },
    { category: "signal_conflict", signalCount: 1 },
    { category: "source_disagreement", signalCount: 1 },
    { category: "stale_data", signalCount: 2 },
    { category: "verification_mismatch", signalCount: 1 },
  ]);
});

test("signal snapshots are copied so later analysis changes cannot rewrite saved context", () => {
  const analysis = {
    evidence: [{ metric: "RSI 14", value: "62.1" }],
    dataSources: [{ source: "Binance", status: "live" }],
    entryIdea: "Paper-only reference entry.",
  };
  const persisted = copySignalSnapshot(analysis);
  analysis.evidence[0].value = "0";
  analysis.dataSources[0].status = "missing";
  assert.equal(persisted.evidence[0].value, "62.1");
  assert.equal(persisted.dataSources[0].status, "live");
});

test("signal evaluation uses forward real candles and invalidation before horizon return", () => {
  const start = Date.UTC(2026, 9, 29, 10);
  const makeCandle = (closeTime: number, high: number, low: number, close: number): Candle => ({
    openTime: closeTime - 60 * 60 * 1_000 + 1,
    closeTime,
    open: 100,
    high,
    low,
    close,
    volume: 1,
    quoteVolume: 100,
  });
  const signal = {
    observedAt: new Date(start),
    referencePriceUsdt: 100,
    stance: "bullish",
    invalidationPriceUsdt: 95,
  };
  const success = evaluateSignalOutcomes(
    signal,
    [makeCandle(start + 60 * 60 * 1_000, 110, 99, 105)],
    1,
    true,
  );
  assert.equal(success.evaluationStatus, "successful");
  assert.equal(success.returnPercent, 5);
  assert.equal(success.maxFavorableReturnPercent, 10);
  const invalidated = evaluateSignalOutcomes(
    signal,
    [makeCandle(start + 60 * 60 * 1_000, 120, 94, 115)],
    1,
    true,
  );
  assert.equal(invalidated.evaluationStatus, "failed");
  assert.match(invalidated.evaluationReason, /invalidation threshold/);
  assert.equal(evaluateSignalOutcomes(
    signal,
    [makeCandle(start + 60 * 60 * 1_000, 101, 94, 97)],
    24,
    true,
  ).evaluationStatus, "failed");
  assert.equal(evaluateSignalOutcomes(
    signal,
    [makeCandle(start + 30 * 60 * 1_000, 102, 99, 101)],
    1,
    true,
  ).evaluationStatus, "open");
  assert.equal(evaluateSignalOutcomes(signal, [], 1, false).evaluationStatus, "insufficient_data");
});

test("market data stays missing when providers return no records", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("[]", { status: 200, headers: { "content-type": "application/json" } });

  try {
    const assets = await getRadarAssets(true);
    const bitcoin = assets.find((asset) => asset.symbol === "BTC");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "missing");
    assert.equal(bitcoin.priceEur, null);
    assert.equal(bitcoin.radarScore, null);

    const snapshot = await getMarketSnapshot("BTC");
    assert.equal(snapshot.priceEur, null);
    assert.equal(snapshot.change24hPercent, null);
    assert.equal(snapshot.hourlyCandles.length, 0);
    assert.equal(snapshot.dailyCandles.length, 0);
    assert.equal(snapshot.hourlyStatus.status, "missing");
    assert.equal(snapshot.dailyStatus.status, "missing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fresh market data flows into the deterministic analysis engine", async () => {
  const originalFetch = globalThis.fetch;
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const dailyRows = makeKlineRows(220, 24 * 60 * 60 * 1_000);
  const hourlyRows = makeKlineRows(48, 60 * 60 * 1_000, 24);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("vs_currency=eur")) {
      return Response.json([{
        id: "ethereum",
        current_price: 1_000,
        market_cap: 10_000_000,
        total_volume: 100_000,
        price_change_percentage_24h: 2,
        price_change_percentage_7d_in_currency: 5,
        last_updated: observedAt,
      }]);
    }
    if (url.includes("vs_currency=usd")) {
      return Response.json([{ id: "ethereum", current_price: 1_080, last_updated: observedAt }]);
    }
    if (url.includes("binance.com") && url.includes("ticker/24hr")) {
      const closeTime = Date.now() - 1_000;
      return Response.json([
        { symbol: "ETHUSDT", lastPrice: "1080", priceChangePercent: "2", quoteVolume: "108000", closeTime },
        { symbol: "EURUSDT", lastPrice: "1.08", priceChangePercent: "0", quoteVolume: "1", closeTime },
      ]);
    }
    if (url.includes("binance.com") && url.includes("/klines")) {
      return Response.json(url.includes("interval=1d") ? dailyRows : hourlyRows);
    }
    return Response.json([]);
  };

  try {
    await getRadarAssets(true);
    const snapshot = await getMarketSnapshot("ETH");
    const analysis = analyzeMarketSnapshot(snapshot);
    assert.ok(Math.abs((snapshot.priceEur ?? 0) - 1_000) < 1e-9);
    assert.equal(snapshot.hourlyStatus.status, "live");
    assert.equal(snapshot.dailyStatus.status, "live");
    assert.equal(analysis.agentResults.find((result) => result.agentId === "technical-analyst")?.dataStatus, "live");
    assert.equal(analysis.agentResults.find((result) => result.agentId === "momentum-scanner")?.stance, "bullish");
    assert.ok(analysis.report.riskScore !== null);
    assert.ok(["long", "strong_long"].includes(analysis.report.decision));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("radar route returns source-backed analysis signals and missing assets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("binance.com") || url.includes("coingecko.com")) {
      return Response.json([]);
    }
    return originalFetch(input, init);
  };

  try {
    const response = await fetch(`${baseUrl}/api/radar`);
    assert.equal(response.status, 200);
    const result = await response.json() as {
      assets: Array<{
        symbol: string;
        dataStatus: string;
        priceEur: number | null;
        signal: { decision: string; radarState: string; riskScore: number | null; scoreFactors: unknown[] } | null;
      }>;
    };
    const bitcoin = result.assets.find((asset) => asset.symbol === "BTC");
    const ethereum = result.assets.find((asset) => asset.symbol === "ETH");
    assert.ok(bitcoin);
    assert.equal(bitcoin.dataStatus, "missing");
    assert.equal(bitcoin.priceEur, null);
    assert.ok(bitcoin.signal);
    assert.equal(bitcoin.signal.radarState, "stand_aside");
    assert.ok(ethereum?.signal);
    assert.ok(["long", "strong_long"].includes(ethereum.signal.decision));
    assert.ok(ethereum.signal.riskScore !== null);
    assert.ok(ethereum.signal.scoreFactors.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis engine does not create a directional result without live evidence", () => {
  const checkedAt = "2026-10-27T12:00:00.000Z";
  const missingSource = {
    source: "Binance",
    status: "missing",
    checkedAt,
    observedAt: null,
    ageMinutes: null,
    detail: "No source data returned.",
  } as const;
  const snapshot = {
    asset: "BTC",
    generatedAt: checkedAt,
    priceEur: null,
    priceEurObserved: null,
    priceUsd: null,
    change24hPercent: null,
    change7dPercent: null,
    volume24hEur: null,
    marketCapEur: null,
    sourceStatuses: [missingSource],
    hourlyCandles: [],
    dailyCandles: [],
    hourlyStatus: missingSource,
    dailyStatus: missingSource,
    sourceDeviationPercent: null,
  } satisfies MarketSnapshot;
  const weights = {
    trend: 12,
    ema: 12,
    rsi: 8,
    atr: 6,
    momentum: 12,
    volume: 10,
    breakout: 10,
    news: 5,
    sentiment: 5,
    macro: 5,
    risk: 8,
    consensus: 7,
  } satisfies ScoreWeights;
  const indicators: Parameters<typeof buildFinalReport>[3] = {
    close: null,
    ema20: null,
    ema50: null,
    ema200: null,
    sma20: null,
    sma50: null,
    rsi14: null,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    atr14: null,
    atrPercent: null,
    volatility20Percent: null,
    support20: null,
    resistance20: null,
    trend: "not_evaluable",
    breakout: null,
  };
  const momentum: Parameters<typeof buildFinalReport>[4] = {
    change6h: null,
    change24h: null,
    volumeChangePercent: null,
    volatilityPercent: null,
    rating: null,
    trend: "not_evaluable",
    output: {
      agentId: "momentum-scanner",
      displayName: "Momentum Scanner",
      status: "complete",
      stance: "not_evaluable",
      summary: "No hourly candles.",
      confidence: 0,
      bullishFactors: [],
      bearishFactors: [],
      risks: [],
      rationale: "No evidence available.",
      evidence: [],
      source: "Binance",
      timestamp: checkedAt,
      dataStatus: "missing",
      dataSources: [missingSource],
      error: null,
    },
  };

  const report = buildFinalReport([], snapshot, weights, indicators, momentum, null);
  assert.equal(report.decision, "no_clear_signal");
  assert.equal(report.stance, "not_evaluable");
  assert.equal(report.radarState, "stand_aside");
  assert.equal(report.confidenceScore, 0);
  assert.equal(report.dataStatus, "missing");
  assert.equal(report.riskScore, null);
  assert.equal(report.longScore, null);
  assert.equal(report.shortScore, null);
});

test("paper-trading P&L is simulated and symmetric for long and short positions", () => {
  assert.equal(calculateTradePnl("long", 2, 100, 110), 20);
  assert.equal(calculateTradePnl("short", 2, 100, 110), -20);
  assert.equal(calculateTradePnl("short", 2, 100, 90), 20);
});

test("paper trading computes configurable fees and validates stops and fee inputs", () => {
  assert.equal(calculatePaperFee(250, 10), 0.25);
  assert.equal(calculatePaperFee(250, 0), 0);
  assert.throws(() => calculatePaperFee(250, 101), RangeError);
  assert.equal(resolvePaperCloseReason("long", 89, 90, 120), "stop_loss");
  assert.equal(resolvePaperCloseReason("long", 121, 90, 120), "take_profit");
  assert.equal(resolvePaperCloseReason("short", 121, 120, 80), "stop_loss");
  assert.equal(resolvePaperCloseReason("short", 79, 120, 80), "take_profit");
  assert.equal(resolvePaperCloseReason("long", 100, 90, 120), null);
});

test("paper price status never labels stale quotes as live", () => {
  const liveSource = {
    source: "CoinGecko · EUR",
    status: "live",
    checkedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    ageMinutes: 0,
    detail: "Fresh quote.",
  } as const;
  const staleSource = { ...liveSource, status: "stale" } as const;
  assert.equal(getPaperPriceDataStatus({
    sourceStatuses: [liveSource],
    priceEur: 100,
    priceEurObserved: 100,
  }), "live");
  assert.equal(getPaperPriceDataStatus({
    sourceStatuses: [staleSource],
    priceEur: 100,
    priceEurObserved: 100,
  }), "stale");
  assert.equal(getPaperPriceDataStatus(undefined), "missing");
});

test("paper trades require a matching directional report and two live evidence agents", () => {
  const report = {
    decision: "long",
    dataStatus: "live",
    confidenceBreakdown: {
      coverageScore: 50,
      freshnessScore: 50,
      agreementScore: 100,
      sourceConsistencyScore: 100,
      verificationScore: 100,
      confirmationCount: 2,
      contradictionCount: 0,
      liveAgentCount: 2,
      totalAgentCount: 10,
      liveSourceCount: 2,
      totalSourceCount: 4,
      methodology: "test fixture",
    },
  } as const;
  const bullishAgents = ["technical-analyst", "momentum-scanner"].map((agentId) => ({
    agentId,
    status: "complete",
    stance: "bullish",
    dataStatus: "live",
    evidence: [{ metric: "price change", value: "+1%" }],
  }));

  assert.equal(hasActionablePaperSignal("long", report, bullishAgents), true);
  assert.equal(hasActionablePaperSignal("short", report, bullishAgents), false);
  assert.equal(hasActionablePaperSignal("long", { ...report, decision: "no_clear_signal" }, bullishAgents), false);
  assert.equal(hasActionablePaperSignal("long", { ...report, dataStatus: "stale" }, bullishAgents), false);
  assert.equal(hasActionablePaperSignal("long", {
    ...report,
    confidenceBreakdown: { ...report.confidenceBreakdown, verificationScore: 50 },
  }, bullishAgents), false);
  assert.equal(hasActionablePaperSignal("long", report, bullishAgents.slice(0, 1)), false);
  assert.equal(hasActionablePaperSignal("long", report, bullishAgents.map((agent) => ({ ...agent, dataStatus: "stale" }))), false);
});

test("paper history computes realized performance only from stored closed trades", () => {
  const performance = calculatePaperPerformance(
    1_000,
    [
      { positionId: "trade-win", side: "long", realizedPnlEur: 100, closedAt: "2026-10-27T10:00:00.000Z" },
      { positionId: "trade-loss", side: "long", realizedPnlEur: -50, closedAt: "2026-10-27T11:00:00.000Z" },
    ],
    [
      { id: "trade-win", signalSnapshot: { agentResults: [{ agentId: "technical-analyst", stance: "bullish", dataStatus: "live" }] } },
      { id: "trade-loss", signalSnapshot: { agentResults: [{ agentId: "technical-analyst", stance: "bullish", dataStatus: "live" }] } },
    ],
  );

  assert.equal(performance.tradeCount, 2);
  assert.equal(performance.winRate, null);
  assert.equal(performance.averageWinEur, null);
  assert.equal(performance.averageLossEur, null);
  assert.equal(performance.maxDrawdownEur, 50);
  assert.equal(performance.status, "insufficient_data");
  assert.equal(performance.winnerCount, 1);
  assert.equal(performance.loserCount, 1);
  assert.equal(performance.totalPnlEur, 50);
  assert.equal(performance.profitFactor, null);
  assert.deepEqual(performance.performanceByAgent, [
    { agentId: "technical-analyst", winRate: null, sampleCount: 2 },
  ]);

  const shortPerformance = calculatePaperPerformance(
    1_000,
    [{ positionId: "short-win", side: "short", realizedPnlEur: 50, closedAt: "2026-10-27T12:00:00.000Z" }],
    [{ id: "short-win", signalSnapshot: { agentResults: [{ agentId: "technical-analyst", stance: "bearish", dataStatus: "live" }] } }],
  );
  assert.deepEqual(shortPerformance.performanceByAgent, [
    { agentId: "technical-analyst", winRate: null, sampleCount: 1 },
  ]);
  assert.equal(calculatePaperPerformance(1_000, [], []).status, "insufficient_data");
});

test("paper performance publishes rates and groupings only after five closed outcomes", () => {
  const outcomes = [100, -50, 20, -10, 5];
  const performance = calculatePaperPerformance(
    1_000,
    outcomes.map((realizedPnlEur, index) => ({
      positionId: `trade-${index}`,
      asset: "BTC" as const,
      side: "long",
      realizedPnlEur,
      closedAt: `2026-10-${String(20 + index).padStart(2, "0")}T10:00:00.000Z`,
    })),
    outcomes.map((_, index) => ({
      id: `trade-${index}`,
      asset: "BTC",
      signalId: `signal-${index}`,
      signalSnapshot: {
        stance: "bullish",
        decision: "long",
        agentResults: [],
      },
    })),
    12,
  );
  assert.equal(performance.status, "measured");
  assert.equal(performance.signalCount, 12);
  assert.equal(performance.winRate, 60);
  assert.equal(performance.totalPnlEur, 65);
  assert.equal(performance.profitFactor, 125 / 60);
  assert.deepEqual(performance.byAsset.map(({ key, tradeCount, status }) => ({ key, tradeCount, status })), [
    { key: "BTC", tradeCount: 5, status: "measured" },
  ]);
  assert.equal(performance.byStance[0].key, "bullish");
  assert.equal(performance.bySignalType[0].key, "long");
  assert.equal(performance.byTimeWindow.length, 1);
});

test("database-backed run flows through radar, linked paper positions, fees and history", {
  skip: !databaseIntegrationEnabled,
}, async () => {
  const originalFetch = globalThis.fetch;
  const accountId = randomUUID();
  let solUsdtPrice = 108;
  const dailyRows = makeKlineRows(220, 24 * 60 * 60 * 1_000, 220, 64.2);
  const hourlyRows = makeKlineRows(48, 60 * 60 * 1_000, 24, 98.6);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("Gemini disabled in local integration test", { status: 503 });
    }
    if (url.includes("vs_currency=eur")) {
      return Response.json([{
        id: "solana",
        current_price: solUsdtPrice / 1.08,
        market_cap: 10_000_000,
        total_volume: 100_000,
        price_change_percentage_24h: 2,
        price_change_percentage_7d_in_currency: 5,
        last_updated: new Date().toISOString(),
      }]);
    }
    if (url.includes("vs_currency=usd")) {
      return Response.json([{
        id: "solana",
        current_price: solUsdtPrice,
        last_updated: new Date().toISOString(),
      }]);
    }
    if (url.includes("binance.com") && url.includes("ticker/24hr")) {
      const closeTime = Date.now() - 1_000;
      return Response.json([
        { symbol: "SOLUSDT", lastPrice: String(solUsdtPrice), priceChangePercent: "2", quoteVolume: "108000", closeTime },
        { symbol: "EURUSDT", lastPrice: "1.08", priceChangePercent: "0", quoteVolume: "1", closeTime },
      ]);
    }
    if (url.includes("binance.com") && url.includes("/klines")) {
      if (url.includes("symbol=SOLUSDT")) {
        return Response.json(url.includes("interval=1d") ? dailyRows : hourlyRows);
      }
      return Response.json([]);
    }
    return originalFetch(input, init);
  };

  try {
    await getRadarAssets(true);
    const startResponse = await fetch(`${baseUrl}/api/analysis/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        asset: "SOL",
        question: "Test a source-backed paper signal.",
      }),
    });
    assert.equal(startResponse.status, 202);
    const started = await startResponse.json() as { runId: string };

    const deadline = Date.now() + 15_000;
    type RunSnapshot = {
      status: string;
      finalReport: { decision: string; riskScore: number | null } | null;
    };
    let completedRun: RunSnapshot | null = null;
    while (Date.now() < deadline) {
      const runResponse = await fetch(
        `${baseUrl}/api/analysis/run?runId=${started.runId}&accountId=${accountId}`,
      );
      assert.equal(runResponse.status, 200);
      completedRun = await runResponse.json() as RunSnapshot;
      if (completedRun?.status === "complete" || completedRun?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(completedRun?.status, "complete");
    assert.ok(completedRun.finalReport);
    assert.ok(["long", "strong_long"].includes(completedRun.finalReport.decision));
    assert.ok(completedRun.finalReport.riskScore !== null);

    const radarResponse = await fetch(`${baseUrl}/api/radar`);
    assert.equal(radarResponse.status, 200);
    const radar = await radarResponse.json() as {
      assets: Array<{ symbol: string; signal: { decision: string } | null }>;
    };
    const solRadar = radar.assets.find((asset) => asset.symbol === "SOL");
    assert.ok(solRadar?.signal);
    assert.ok(["long", "strong_long"].includes(solRadar.signal.decision));

    const { db, radarSignals } = await import("@workspace/db");
    const [recordedSignal] = await db.insert(radarSignals).values({
      signalKey: `phase5-test:${randomUUID()}`,
      asset: "SOL",
      signalType: "long",
      stance: "bullish",
      confidenceScore: 75,
      observedAt: new Date(Date.now() - 1_000),
      referencePriceUsdt: "108",
      entryPriceEur: "100",
      invalidationPriceUsdt: "90",
      invalidationPriceEur: "83.3333333333",
      dataStatus: "live",
      snapshot: {
        stance: "bullish",
        decision: "long",
        confidenceBreakdown: { verificationScore: 90 },
        evidence: [{
          metric: "EMA 20",
          value: "105.00",
          source: "Binance · 1d candles",
          timestamp: new Date().toISOString(),
          dataStatus: "live",
        }],
        technicalSignals: [],
        dataSources: [],
      },
    }).returning();
    assert.ok(recordedSignal);
    const signalOpenResponse = await fetch(`${baseUrl}/api/paper/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        signalId: recordedSignal.id,
        side: "long",
        sizeEur: 50,
        stopLossEur: 83.3333333333,
        takeProfitEur: null,
        feeRateBps: 10,
      }),
    });
    assert.equal(signalOpenResponse.status, 201);
    const signalOpened = await signalOpenResponse.json() as {
      position: { positionId: string; signalId: string; entryFeeEur: number; feeRateBps: number };
    };
    assert.equal(signalOpened.position.signalId, recordedSignal.id);
    assert.equal(signalOpened.position.entryFeeEur, 0.05);
    assert.equal(signalOpened.position.feeRateBps, 10);
    const duplicateSignalTrade = await fetch(`${baseUrl}/api/paper/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        signalId: recordedSignal.id,
        side: "long",
        sizeEur: 50,
        stopLossEur: null,
        takeProfitEur: null,
        feeRateBps: 10,
      }),
    });
    assert.equal(duplicateSignalTrade.status, 409);
    const signalHistoryResponse = await fetch(`${baseUrl}/api/radar/signals`);
    assert.equal(signalHistoryResponse.status, 200);
    const signalHistory = await signalHistoryResponse.json() as {
      signals: Array<{ signalId: string; evidence: Array<{ metric: string }> }>;
    };
    assert.ok(signalHistory.signals.some((signal) =>
      signal.signalId === recordedSignal.id && signal.evidence.some((item) => item.metric === "EMA 20"),
    ));
    const signalCloseResponse = await fetch(
      `${baseUrl}/api/paper/trades/${signalOpened.position.positionId}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      },
    );
    assert.equal(signalCloseResponse.status, 200);
    const signalClosed = await signalCloseResponse.json() as {
      position: { signalId: string; realizedPnlEur: number | null; exitFeeEur: number };
    };
    assert.equal(signalClosed.position.signalId, recordedSignal.id);
    assert.equal(signalClosed.position.realizedPnlEur, -0.1);
    assert.equal(signalClosed.position.exitFeeEur, 0.05);

    const openResponse = await fetch(`${baseUrl}/api/paper/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        runId: started.runId,
        side: "long",
        sizeEur: 100,
        stopLossEur: null,
        takeProfitEur: null,
        feeRateBps: 10,
      }),
    });
    assert.equal(openResponse.status, 201);
    const opened = await openResponse.json() as {
      position: { positionId: string; entryFeeEur: number };
      portfolio: { positions: unknown[] };
    };
    assert.equal(opened.portfolio.positions.length, 1);
    assert.equal(opened.position.entryFeeEur, 0.1);

    solUsdtPrice = 109.08;
    await getRadarAssets(true);
    const closeResponse = await fetch(
      `${baseUrl}/api/paper/trades/${opened.position.positionId}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      },
    );
    assert.equal(closeResponse.status, 200);
    const closed = await closeResponse.json() as {
      position: { realizedPnlEur: number | null };
      portfolio: { closedTrades: Array<{ realizedPnlEur: number | null }> };
    };
    assert.ok((closed.position.realizedPnlEur ?? 0) > 0);
    assert.equal(closed.portfolio.closedTrades.length, 2);
    const paperPerformanceResponse = await fetch(
      `${baseUrl}/api/paper/performance?accountId=${accountId}`,
    );
    assert.equal(paperPerformanceResponse.status, 200);
    const paperPerformance = await paperPerformanceResponse.json() as {
      status: string;
      tradeCount: number;
      winRate: number | null;
    };
    assert.equal(paperPerformance.status, "insufficient_data");
    assert.equal(paperPerformance.tradeCount, 2);
    assert.equal(paperPerformance.winRate, null);

    const noSignalStart = await fetch(`${baseUrl}/api/analysis/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        asset: "BTC",
        question: "No source data should mean no signal.",
      }),
    });
    assert.equal(noSignalStart.status, 202);
    const noSignalRun = await noSignalStart.json() as { runId: string };
    let noSignalStatus = "queued";
    const noSignalDeadline = Date.now() + 15_000;
    while (Date.now() < noSignalDeadline && noSignalStatus !== "complete" && noSignalStatus !== "error") {
      const runResponse = await fetch(
        `${baseUrl}/api/analysis/run?runId=${noSignalRun.runId}&accountId=${accountId}`,
      );
      const run = await runResponse.json() as { status: string };
      noSignalStatus = run.status;
      if (noSignalStatus !== "complete" && noSignalStatus !== "error") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(noSignalStatus, "complete");
    const rejectedTrade = await fetch(`${baseUrl}/api/paper/trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId,
        runId: noSignalRun.runId,
        side: "long",
        sizeEur: 100,
        stopLossEur: null,
        takeProfitEur: null,
      }),
    });
    assert.equal(rejectedTrade.status, 409);
    assert.equal((await rejectedTrade.json() as { code: string }).code, "PAPER_SIGNAL_NOT_ACTIONABLE");

    const historyResponse = await fetch(`${baseUrl}/api/analysis/history?accountId=${accountId}`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { runs: Array<{ runId: string }> };
    assert.equal(history.runs.length, 2);
    assert.ok(history.runs.some((run) => run.runId === started.runId));

    const portfolioResponse = await fetch(`${baseUrl}/api/paper/portfolio?accountId=${accountId}`);
    assert.equal(portfolioResponse.status, 200);
    const portfolio = await portfolioResponse.json() as {
      positions: unknown[];
      closedTrades: Array<{ realizedPnlEur: number | null }>;
      performance: {
        tradeCount: number;
        performanceByAgent: Array<{ agentId: string; winRate: number | null; sampleCount: number }>;
      };
    };
    assert.equal(portfolio.positions.length, 0);
    assert.equal(portfolio.closedTrades.length, 2);
    assert.equal(portfolio.performance.tradeCount, 2);
    assert.ok(portfolio.performance.performanceByAgent.length > 0);
    assert.ok(portfolio.performance.performanceByAgent.some((agent) => agent.winRate === null));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
