import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import type { ScoreWeights } from "@workspace/api-zod";
import type { MarketSnapshot } from "./lib/market-data";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const [
  { default: apiRouter },
  { buildFinalReport },
  { computeRadarScore, getMarketSnapshot, getRadarAssets },
  { calculateTradePnl },
] = await Promise.all([
    import("./routes"),
    import("./lib/analysis-engine"),
    import("./lib/market-data"),
    import("./lib/paper-service"),
  ]);

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

let server: Server;
let baseUrl: string;

before(async () => {
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

  const settings = await fetch(`${baseUrl}/api/settings?accountId=invalid`);
  assert.equal(settings.status, 400);

  const openTrade = await fetch(`${baseUrl}/api/paper/trades`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(openTrade.status, 400);
});

test("radar score requires complete data and returns a deterministic score", () => {
  assert.equal(computeRadarScore(0, 100, 10_000), 51);
  assert.equal(computeRadarScore(null, 100, 10_000), null);
  assert.equal(computeRadarScore(1, 100, 0), null);
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

test("radar route returns source statuses from the market-data service", async () => {
  const response = await fetch(`${baseUrl}/api/radar`);
  assert.equal(response.status, 200);
  const result = await response.json() as {
    assets: Array<{ symbol: string; dataStatus: string; priceEur: number | null }>;
  };
  const bitcoin = result.assets.find((asset: { symbol: string }) => asset.symbol === "BTC");
  assert.ok(bitcoin);
  assert.equal(bitcoin.dataStatus, "missing");
  assert.equal(bitcoin.priceEur, null);
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
    rsi14: null,
    atr14: null,
    atrPercent: null,
    breakout: null,
  };
  const momentum: Parameters<typeof buildFinalReport>[4] = {
    change6h: null,
    change24h: null,
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
  assert.equal(report.confidenceScore, 0);
  assert.equal(report.riskScore, null);
  assert.equal(report.longScore, null);
  assert.equal(report.shortScore, null);
});

test("paper-trading P&L is simulated and symmetric for long and short positions", () => {
  assert.equal(calculateTradePnl("long", 2, 100, 110), 20);
  assert.equal(calculateTradePnl("short", 2, 100, 110), -20);
  assert.equal(calculateTradePnl("short", 2, 100, 90), 20);
});
