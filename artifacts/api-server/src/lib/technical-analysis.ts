import type { Candle } from "./market-data";

export type TechnicalIndicators = {
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr14: number | null;
  atrPercent: number | null;
  volatility20Percent: number | null;
  support20: number | null;
  resistance20: number | null;
  trend: "bullish" | "bearish" | "mixed" | "not_evaluable";
  breakout: "above" | "below" | "inside" | null;
};

export type MomentumIndicators = {
  change6h: number | null;
  change24h: number | null;
  volumeChangePercent: number | null;
  trend: "bullish" | "bearish" | "mixed" | "not_evaluable";
  volatilityPercent: number | null;
  rating: number | null;
};

export function simpleMovingAverage(values: number[], period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return null;
  const sample = values.slice(-period);
  if (sample.some((value) => !Number.isFinite(value))) return null;
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

export function exponentialMovingAverage(values: number[], period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return null;
  const sample = values.slice(-Math.max(period, values.length));
  if (sample.some((value) => !Number.isFinite(value))) return null;
  const seed = sample.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  return sample
    .slice(period)
    .reduce((previous, value) => value * multiplier + previous * (1 - multiplier), seed);
}

function exponentialMovingAverageSeries(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;
  for (let index = period; index < values.length; index += 1) {
    result[index] = values[index] * multiplier + result[index - 1]! * (1 - multiplier);
  }
  return result;
}

export function relativeStrengthIndex(values: number[], period = 14): number | null {
  if (!Number.isInteger(period) || period <= 0 || values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let averageGain = changes.slice(0, period).reduce((sum, change) => sum + Math.max(change, 0), 0) / period;
  let averageLoss = changes.slice(0, period).reduce((sum, change) => sum + Math.max(-change, 0), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function averageTrueRange(candles: Candle[], period = 14): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length <= period) return null;
  const trueRanges = candles.slice(-period).map((candle, index) => {
    const previousClose = candles[candles.length - period + index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return trueRanges.reduce((sum, value) => sum + value, 0) / period;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function calculateTechnicalIndicators(candles: Candle[]): TechnicalIndicators {
  const closes = candles.map((candle) => candle.close);
  const close = closes.at(-1) ?? null;
  const ema20 = exponentialMovingAverage(closes, 20);
  const ema50 = exponentialMovingAverage(closes, 50);
  const ema200 = exponentialMovingAverage(closes, 200);
  const rsi14 = relativeStrengthIndex(closes);
  const atr14 = averageTrueRange(candles);
  const dailyReturns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const volatility20 = standardDeviation(dailyReturns.slice(-20));
  const macdFast = exponentialMovingAverageSeries(closes, 12);
  const macdSlow = exponentialMovingAverageSeries(closes, 26);
  const macdLine = closes.flatMap((_, index) =>
    macdFast[index] === null || macdSlow[index] === null
      ? []
      : [{ index, value: macdFast[index]! - macdSlow[index]! }],
  );
  const macdSignalSeries = exponentialMovingAverageSeries(
    macdLine.map((point) => point.value),
    9,
  );
  const macdIndex = macdLine.length - 1;
  const macd = macdLine.at(-1)?.value ?? null;
  const macdSignal = macdIndex >= 0 ? macdSignalSeries[macdIndex] ?? null : null;
  const macdHistogram =
    macd !== null && macdSignal !== null ? macd - macdSignal : null;
  const previous20 = candles.slice(-21, -1);
  const support20 =
    previous20.length === 20 ? Math.min(...previous20.map((candle) => candle.low)) : null;
  const resistance20 =
    previous20.length === 20 ? Math.max(...previous20.map((candle) => candle.high)) : null;
  const breakout =
    close !== null && support20 !== null && resistance20 !== null
      ? close > resistance20
        ? "above"
        : close < support20
          ? "below"
          : "inside"
      : null;
  const trend =
    close === null || ema20 === null || ema50 === null
      ? "not_evaluable"
      : close > ema20 && ema20 > ema50
        ? "bullish"
        : close < ema20 && ema20 < ema50
          ? "bearish"
          : "mixed";

  return {
    close,
    ema20,
    ema50,
    ema200,
    sma20: simpleMovingAverage(closes, 20),
    sma50: simpleMovingAverage(closes, 50),
    rsi14,
    macd,
    macdSignal,
    macdHistogram,
    atr14,
    atrPercent: close !== null && close > 0 && atr14 !== null ? (atr14 / close) * 100 : null,
    volatility20Percent: volatility20 === null ? null : volatility20 * 100,
    support20,
    resistance20,
    trend,
    breakout,
  };
}

export function calculateMomentumIndicators(candles: Candle[]): MomentumIndicators {
  const closes = candles.map((candle) => candle.close);
  const last = candles.at(-1);
  const sixHoursAgo = candles.at(-7);
  const oneDayAgo = candles.at(-25);
  const change6h =
    last && sixHoursAgo && sixHoursAgo.close > 0
      ? ((last.close - sixHoursAgo.close) / sixHoursAgo.close) * 100
      : null;
  const change24h =
    last && oneDayAgo && oneDayAgo.close > 0
      ? ((last.close - oneDayAgo.close) / oneDayAgo.close) * 100
      : null;
  const last24Volume = candles.slice(-24).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const previous24Volume = candles.slice(-48, -24).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const volumeChangePercent =
    candles.length >= 48 && previous24Volume > 0
      ? ((last24Volume - previous24Volume) / previous24Volume) * 100
      : null;
  const ema20 = exponentialMovingAverage(closes, 20);
  const ema50 = exponentialMovingAverage(closes, 50);
  const trend =
    last === undefined || ema20 === null
      ? "not_evaluable"
      : last.close > ema20 && (ema50 === null || ema20 > ema50)
        ? "bullish"
        : last.close < ema20 && (ema50 === null || ema20 < ema50)
          ? "bearish"
          : "mixed";
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const hourlyVolatility = standardDeviation(returns.slice(-24));
  const volatilityPercent =
    hourlyVolatility === null ? null : hourlyVolatility * Math.sqrt(24) * 100;

  if (
    change6h === null ||
    change24h === null ||
    volumeChangePercent === null ||
    trend === "not_evaluable" ||
    volatilityPercent === null
  ) {
    return { change6h, change24h, volumeChangePercent, trend, volatilityPercent, rating: null };
  }

  const priceScore = clamp(50 + change6h * 1.5 + change24h * 2.5, 0, 100);
  const volumeScore = clamp(50 + volumeChangePercent * 0.25, 0, 100);
  const trendScore = trend === "bullish" ? 100 : trend === "bearish" ? 0 : 50;
  const volatilityScore = clamp(100 - volatilityPercent * 10, 0, 100);
  const rating =
    priceScore * 0.35 +
    volumeScore * 0.25 +
    trendScore * 0.25 +
    volatilityScore * 0.15;
  return {
    change6h,
    change24h,
    volumeChangePercent,
    trend,
    volatilityPercent,
    rating: Math.round(rating * 10) / 10,
  };
}
