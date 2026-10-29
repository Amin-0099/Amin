import type { AssetCode, DataSourceStatus, MarketAsset } from "@workspace/api-zod";

export const assetCatalog: Array<
  Pick<MarketAsset, "symbol" | "name" | "category">
> = [
  { symbol: "BTC", name: "Bitcoin", category: "crypto" },
  { symbol: "ETH", name: "Ethereum", category: "crypto" },
  { symbol: "SOL", name: "Solana", category: "crypto" },
  { symbol: "BNB", name: "BNB", category: "crypto" },
  { symbol: "XRP", name: "XRP", category: "crypto" },
  { symbol: "ADA", name: "Cardano", category: "crypto" },
  { symbol: "DOGE", name: "Dogecoin", category: "crypto" },
  { symbol: "AVAX", name: "Avalanche", category: "crypto" },
  { symbol: "LINK", name: "Chainlink", category: "crypto" },
  { symbol: "LTC", name: "Litecoin", category: "crypto" },
  { symbol: "COIN", name: "Coinbase", category: "crypto_equity" },
  { symbol: "MSTR", name: "Strategy", category: "crypto_equity" },
  { symbol: "NVDA", name: "NVIDIA", category: "semiconductor" },
  { symbol: "ASML", name: "ASML", category: "semiconductor" },
  { symbol: "TSM", name: "TSMC", category: "semiconductor" },
  { symbol: "AAPL", name: "Apple", category: "big_tech" },
  { symbol: "MSFT", name: "Microsoft", category: "big_tech" },
  { symbol: "DAX", name: "DAX", category: "eu_equity" },
  { symbol: "XAU", name: "Gold", category: "commodity" },
  { symbol: "OIL", name: "Crude oil", category: "commodity" },
];

const cryptoAssets: Partial<
  Record<AssetCode, { coinGeckoId: string; binanceSymbol: string }>
> = {
  BTC: { coinGeckoId: "bitcoin", binanceSymbol: "BTCUSDT" },
  ETH: { coinGeckoId: "ethereum", binanceSymbol: "ETHUSDT" },
  SOL: { coinGeckoId: "solana", binanceSymbol: "SOLUSDT" },
  BNB: { coinGeckoId: "binancecoin", binanceSymbol: "BNBUSDT" },
  XRP: { coinGeckoId: "ripple", binanceSymbol: "XRPUSDT" },
  ADA: { coinGeckoId: "cardano", binanceSymbol: "ADAUSDT" },
  DOGE: { coinGeckoId: "dogecoin", binanceSymbol: "DOGEUSDT" },
  AVAX: { coinGeckoId: "avalanche-2", binanceSymbol: "AVAXUSDT" },
  LINK: { coinGeckoId: "chainlink", binanceSymbol: "LINKUSDT" },
  LTC: { coinGeckoId: "litecoin", binanceSymbol: "LTCUSDT" },
};

export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};

export type MarketSnapshot = {
  asset: AssetCode;
  generatedAt: string;
  priceEur: number | null;
  priceEurObserved: number | null;
  priceUsd: number | null;
  change24hPercent: number | null;
  change7dPercent: number | null;
  volume24hEur: number | null;
  marketCapEur: number | null;
  sourceStatuses: DataSourceStatus[];
  hourlyCandles: Candle[];
  dailyCandles: Candle[];
  hourlyStatus: DataSourceStatus;
  dailyStatus: DataSourceStatus;
  sourceDeviationPercent: number | null;
};

type CoinGeckoMarket = {
  id: string;
  current_price?: unknown;
  market_cap?: unknown;
  total_volume?: unknown;
  price_change_percentage_24h?: unknown;
  price_change_percentage_7d_in_currency?: unknown;
  last_updated?: unknown;
  sparkline_in_7d?: { price?: unknown };
};

type BinanceTicker = {
  symbol: string;
  lastPrice: unknown;
  priceChangePercent: unknown;
  quoteVolume: unknown;
  closeTime: number;
};

type SourceResult<T> = {
  data: T | null;
  status: DataSourceStatus;
};

type CachedRadar = {
  expiresAt: number;
  value: MarketAsset[];
};

type QuoteDetails = {
  priceUsd: number | null;
  priceEurLive: number | null;
  sourceDeviationPercent: number | null;
};

const BINANCE_BASE = "https://api.binance.com/api/v3";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const QUOTE_FRESHNESS_MINUTES = 5;
const HOURLY_CANDLE_STALE_MINUTES = 90;
const DAILY_CANDLE_STALE_HOURS = 36;
const RADAR_CACHE_MS = 45_000;
const CANDLE_CACHE_MS = 60_000;
let radarCache: CachedRadar | null = null;
let radarInFlight: Promise<MarketAsset[]> | null = null;
const quoteDetails = new Map<AssetCode, QuoteDetails>();
const candleCache = new Map<string, { expiresAt: number; value: SourceResult<Candle[]> }>();

const isoNow = () => new Date().toISOString();

function statusFor(
  source: string,
  observedAt: string | null,
  freshnessMinutes: number,
  detail: string,
  checkedAt = isoNow(),
): DataSourceStatus {
  if (!observedAt) {
    return {
      source,
      status: "stale",
      checkedAt,
      observedAt: null,
      ageMinutes: null,
      detail: `${detail} The source timestamp was unavailable, so freshness could not be confirmed.`,
    };
  }

  const observedMillis = Date.parse(observedAt);
  if (!Number.isFinite(observedMillis)) {
    return {
      source,
      status: "stale",
      checkedAt,
      observedAt: null,
      ageMinutes: null,
      detail: `${detail} The source timestamp was invalid, so freshness could not be confirmed.`,
    };
  }
  const checkedMillis = Date.parse(checkedAt);
  if (observedMillis > checkedMillis) {
    return {
      source,
      status: "stale",
      checkedAt,
      observedAt,
      ageMinutes: 0,
      detail: `${detail} The source timestamp is in the future, so freshness could not be confirmed.`,
    };
  }
  const ageMinutes = (checkedMillis - observedMillis) / 60_000;
  const status = ageMinutes <= freshnessMinutes ? "live" : "stale";
  return {
    source,
    status,
    checkedAt,
    observedAt,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    detail:
      status === "live"
        ? detail
        : `${detail} Source data is older than the freshness threshold.`,
  };
}

function missingStatus(source: string, detail: string, checkedAt = isoNow()): DataSourceStatus {
  return {
    source,
    status: "missing",
    checkedAt,
    observedAt: null,
    ageMinutes: null,
    detail,
  };
}

function aggregateStatus(statuses: DataSourceStatus[]): DataSourceStatus["status"] {
  if (statuses.some((source) => source.status === "live")) return "live";
  if (statuses.some((source) => source.status === "stale")) return "stale";
  return "missing";
}

async function fetchJson<T>(source: string, url: string): Promise<SourceResult<T>> {
  const checkedAt = isoNow();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const detail =
        response.status === 429
          ? `${source} rate limit reached.`
          : `${source} returned HTTP ${response.status}.`;
      return { data: null, status: missingStatus(source, detail, checkedAt) };
    }
    return {
      data: (await response.json()) as T,
      status: statusFor(source, checkedAt, QUOTE_FRESHNESS_MINUTES, `${source} returned data.`, checkedAt),
    };
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? `${source} request timed out.`
        : `${source} could not be reached or returned invalid JSON.`;
    return { data: null, status: missingStatus(source, detail, checkedAt) };
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function epochMillis(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null &&
    Number.isSafeInteger(number) &&
    number >= 0 &&
    number <= 8_640_000_000_000_000
    ? number
    : null;
}

function sourceTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseMarkets(data: unknown): Map<string, CoinGeckoMarket> {
  if (!Array.isArray(data)) return new Map();
  const rows = data.filter(
    (item): item is CoinGeckoMarket =>
      item !== null &&
      typeof item === "object" &&
      "id" in item &&
      typeof item.id === "string",
  );
  return new Map(rows.map((item) => [item.id, item]));
}

function parseBinanceTickers(data: unknown): Map<string, BinanceTicker> {
  if (!data) return new Map();
  const candidates = Array.isArray(data) ? data : [data];
  const rows = candidates.flatMap((item): BinanceTicker[] => {
    if (item === null || typeof item !== "object" || !("symbol" in item)) return [];
    if (typeof item.symbol !== "string" || !("closeTime" in item)) return [];
    const closeTime = epochMillis(item.closeTime);
    if (closeTime === null) return [];
    return [{
      symbol: item.symbol,
      lastPrice: "lastPrice" in item ? item.lastPrice : null,
      priceChangePercent: "priceChangePercent" in item ? item.priceChangePercent : null,
      quoteVolume: "quoteVolume" in item ? item.quoteVolume : null,
      closeTime,
    }];
  });
  return new Map(rows.map((item) => [item.symbol, item]));
}

export function computeRadarScore(change: number | null, volume: number | null, cap: number | null): number | null {
  if (
    change === null ||
    volume === null ||
    cap === null ||
    !Number.isFinite(change) ||
    !Number.isFinite(volume) ||
    !Number.isFinite(cap) ||
    volume < 0 ||
    cap <= 0
  ) return null;
  const activity = Math.min(25, (volume / cap) * 100);
  return Math.round(Math.max(0, Math.min(100, 50 + Math.min(25, Math.abs(change) * 2) + activity)) * 10) / 10;
}

function buildRadarAssets(
  cgEur: Map<string, CoinGeckoMarket>,
  cgUsd: Map<string, CoinGeckoMarket>,
  binance: Map<string, BinanceTicker>,
  checkedAt: string,
  cgEurAvailable: boolean,
  cgUsdAvailable: boolean,
  binanceAvailable: boolean,
  failureDetails: { cgEur: string; cgUsd: string; binance: string },
): MarketAsset[] {
  return assetCatalog.map((asset) => {
    const config = cryptoAssets[asset.symbol];
    if (!config) {
      quoteDetails.set(asset.symbol, {
        priceUsd: null,
        priceEurLive: null,
        sourceDeviationPercent: null,
      });
      const status = missingStatus(
        "CoinGecko / Binance",
        "No public market-data connector is configured for this asset class.",
        checkedAt,
      );
      return {
        ...asset,
        priceEur: null,
        change24hPercent: null,
        change7dPercent: null,
        volume24hEur: null,
        marketCapEur: null,
        dataStatus: "missing",
        sourceStatuses: [status],
        radarScore: null,
        momentumRating: null,
        signal: null,
        sparkline: [],
      };
    }

    const eur = cgEur.get(config.coinGeckoId);
    const usd = cgUsd.get(config.coinGeckoId);
    const ticker = binance.get(config.binanceSymbol);
    const eurUsdtTicker = binance.get("EURUSDT");
    const eurUsdt = positiveNumber(eurUsdtTicker?.lastPrice);
    const eurUpdated = sourceTimestamp(eur?.last_updated);
    const usdUpdated = sourceTimestamp(usd?.last_updated);
    const cgPriceEur = positiveNumber(eur?.current_price);
    const cgPriceUsd = positiveNumber(usd?.current_price);
    const binancePrice = positiveNumber(ticker?.lastPrice);
    const hasBinanceEurPrice = binancePrice !== null && eurUsdt !== null;
    const sourceStatuses = [
      eur && cgEurAvailable && cgPriceEur !== null
        ? statusFor("CoinGecko · EUR", eurUpdated, QUOTE_FRESHNESS_MINUTES, "EUR quote and volume retrieved.", checkedAt)
        : missingStatus("CoinGecko · EUR", cgEurAvailable ? "Asset quote is missing or invalid." : failureDetails.cgEur, checkedAt),
      usd && cgUsdAvailable && cgPriceUsd !== null
        ? statusFor("CoinGecko · USD", usdUpdated, QUOTE_FRESHNESS_MINUTES, "USD quote retrieved for cross-source comparison.", checkedAt)
        : missingStatus("CoinGecko · USD", cgUsdAvailable ? "Asset quote is missing or invalid." : failureDetails.cgUsd, checkedAt),
      ticker && binanceAvailable && binancePrice !== null
        ? statusFor("Binance · USDT ticker", new Date(ticker.closeTime).toISOString(), QUOTE_FRESHNESS_MINUTES, "Public 24-hour ticker retrieved.", checkedAt)
        : missingStatus("Binance · USDT ticker", binanceAvailable ? "Trading pair quote is missing or invalid." : failureDetails.binance, checkedAt),
      eurUsdtTicker && binanceAvailable && eurUsdt !== null
        ? statusFor("Binance · EURUSDT conversion", new Date(eurUsdtTicker.closeTime).toISOString(), QUOTE_FRESHNESS_MINUTES, "EUR/USDT conversion quote retrieved.", checkedAt)
        : missingStatus("Binance · EURUSDT conversion", binanceAvailable ? "A valid EUR/USDT quote is required to convert Binance data to EUR." : failureDetails.binance, checkedAt),
    ];
    const cgEurStatus = sourceStatuses[0];
    const cgUsdStatus = sourceStatuses[1];
    const binanceQuoteStatus = sourceStatuses[2];
    const eurConversionStatus = sourceStatuses[3];
    const binancePriceEur =
      hasBinanceEurPrice
        ? binancePrice / eurUsdt
        : null;
    const liveBinancePrice =
      binanceQuoteStatus.status === "live" &&
      eurConversionStatus.status === "live"
        ? binancePriceEur
        : null;
    const liveCoinGeckoPrice =
      cgEurStatus.status === "live" ? cgPriceEur : null;
    const observedBinancePrice = hasBinanceEurPrice ? binancePriceEur : null;
    const priceEur =
      liveBinancePrice ??
      liveCoinGeckoPrice ??
      observedBinancePrice ??
      cgPriceEur;
    const change24hPercent =
      (binanceQuoteStatus.status === "live"
        ? finiteNumber(ticker?.priceChangePercent)
        : null) ??
      (cgEurStatus.status === "live"
        ? finiteNumber(eur?.price_change_percentage_24h)
        : null);
    const binanceVolumeEur =
      binanceQuoteStatus.status === "live" && eurConversionStatus.status === "live"
        ? (() => {
            const quoteVolume = positiveNumber(ticker?.quoteVolume);
            return quoteVolume !== null && eurUsdt !== null
              ? quoteVolume / eurUsdt
              : null;
          })()
        : null;
    const volume24hEur = binanceVolumeEur ??
      (cgEurStatus.status === "live" ? positiveNumber(eur?.total_volume) : null);
    const marketCapEur =
      cgEurStatus.status === "live" ? positiveNumber(eur?.market_cap) : null;
    const priceUsd = cgUsdStatus.status === "live" ? cgPriceUsd : null;
    const sourceDeviationPercent =
      priceUsd !== null &&
      binancePrice !== null &&
      binanceQuoteStatus.status === "live"
        ? (Math.abs(priceUsd - binancePrice) / priceUsd) * 100
        : null;
    const priceEurLive = liveBinancePrice ?? liveCoinGeckoPrice;
    const stalePriceEur =
      priceEurLive === null && (binanceQuoteStatus.status === "stale" || eurConversionStatus.status === "stale")
        ? observedBinancePrice
        : priceEurLive === null && cgEurStatus.status === "stale"
          ? cgPriceEur
          : null;
    const dataStatus =
      priceEurLive !== null
        ? "live"
        : stalePriceEur !== null
          ? "stale"
          : "missing";
    quoteDetails.set(asset.symbol, {
      priceUsd,
      priceEurLive,
      sourceDeviationPercent,
    });

    return {
      ...asset,
      priceEur: priceEurLive ?? stalePriceEur,
      change24hPercent,
      change7dPercent:
        cgEurStatus.status === "live"
          ? finiteNumber(eur?.price_change_percentage_7d_in_currency)
          : null,
      volume24hEur,
      marketCapEur,
      dataStatus,
      sourceStatuses,
      radarScore: computeRadarScore(change24hPercent, volume24hEur, marketCapEur),
      momentumRating: null,
      signal: null,
      sparkline:
        cgEurStatus.status === "live" && Array.isArray(eur?.sparkline_in_7d?.price)
          ? eur.sparkline_in_7d.price
              .map((value) => finiteNumber(value))
              .filter((value): value is number => value !== null)
          : [],
    };
  });
}

export async function getRadarAssets(forceRefresh = false): Promise<MarketAsset[]> {
  if (!forceRefresh && radarCache && radarCache.expiresAt > Date.now()) {
    return radarCache.value;
  }
  if (radarInFlight) return radarInFlight;

  radarInFlight = (async () => {
    const cgIds = Object.values(cryptoAssets).map((config) => config.coinGeckoId);
    const symbols = Object.values(cryptoAssets).map((config) => config.binanceSymbol);
    const quoteUrl = (currency: "eur" | "usd") =>
      `${COINGECKO_BASE}/coins/markets?vs_currency=${currency}&ids=${cgIds.join(",")}&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h%2C7d`;
    const binanceUrl = `${BINANCE_BASE}/ticker/24hr?${new URLSearchParams({
      symbols: JSON.stringify([...symbols, "EURUSDT"]),
    })}`;
    const [eurResult, usdResult, binanceResult] = await Promise.all([
      fetchJson<unknown>("CoinGecko · EUR", quoteUrl("eur")),
      fetchJson<unknown>("CoinGecko · USD", quoteUrl("usd")),
      fetchJson<unknown>("Binance · USDT ticker", binanceUrl),
    ]);
    const checkedAt = isoNow();
    const eurMarkets = parseMarkets(eurResult.data);
    const usdMarkets = parseMarkets(usdResult.data);
    const binanceTickers = parseBinanceTickers(binanceResult.data);
    const value = buildRadarAssets(
      eurMarkets,
      usdMarkets,
      binanceTickers,
      checkedAt,
      Array.isArray(eurResult.data),
      Array.isArray(usdResult.data),
      binanceResult.data !== null,
      {
        cgEur: eurResult.data === null ? eurResult.status.detail : "CoinGecko returned invalid market data.",
        cgUsd: usdResult.data === null ? usdResult.status.detail : "CoinGecko returned invalid market data.",
        binance: binanceResult.data === null ? binanceResult.status.detail : "Binance returned invalid ticker data.",
      },
    );
    radarCache = { value, expiresAt: Date.now() + RADAR_CACHE_MS };
    return value;
  })();

  try {
    return await radarInFlight;
  } finally {
    radarInFlight = null;
  }
}

export function parseCandles(data: unknown): Candle[] {
  if (!Array.isArray(data)) return [];
  const parsed = data
    .flatMap((row): Candle[] => {
      if (!Array.isArray(row) || row.length < 8) return [];
      const values = row.slice(0, 8).map(finiteNumber);
      if (values.some((value) => value === null)) return [];
      const [rawOpenTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume, rawCloseTime, rawQuoteVolume] =
        values as number[];
      const openTime = epochMillis(rawOpenTime);
      const closeTime = epochMillis(rawCloseTime);
      if (
        openTime === null ||
        closeTime === null ||
        closeTime <= openTime ||
        closeTime >= Date.now() ||
        rawOpen <= 0 ||
        rawHigh <= 0 ||
        rawLow <= 0 ||
        rawClose <= 0 ||
        rawVolume < 0 ||
        rawQuoteVolume < 0 ||
        rawHigh < Math.max(rawOpen, rawClose) ||
        rawLow > Math.min(rawOpen, rawClose)
      ) {
        return [];
      }
      return [{
        openTime,
        closeTime,
        open: rawOpen,
        high: rawHigh,
        low: rawLow,
        close: rawClose,
        volume: rawVolume,
        quoteVolume: rawQuoteVolume,
      }];
    });
  return [...new Map(parsed.map((candle) => [candle.openTime, candle])).values()]
    .sort((left, right) => left.openTime - right.openTime);
}

export function haveContinuousCandles(
  candles: Candle[],
  interval: "1h" | "1d",
): boolean {
  const expectedIntervalMs = interval === "1h" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
  return candles.every((candle, index) =>
    candle.closeTime < candle.openTime + expectedIntervalMs &&
    (index === 0 || candle.openTime - candles[index - 1].openTime === expectedIntervalMs),
  );
}

async function getCandles(
  asset: AssetCode,
  interval: "1h" | "1d",
  forceRefresh = false,
): Promise<SourceResult<Candle[]>> {
  const config = cryptoAssets[asset];
  const source = `Binance · ${interval} candles`;
  if (!config) {
    return {
      data: null,
      status: missingStatus(source, "No candle provider is connected for this asset."),
    };
  }

  const cacheKey = `${asset}:${interval}`;
  const cached = candleCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const checkedAt = isoNow();
  const url = `${BINANCE_BASE}/klines?symbol=${config.binanceSymbol}&interval=${interval}&limit=300`;
  const result = await fetchJson<unknown>(source, url);
  const candles = parseCandles(result.data);
  if (!result.data || !candles.length) {
    const failure = {
      data: null,
      status: missingStatus(source, result.status.detail || "No completed candles were returned.", checkedAt),
    };
    candleCache.set(cacheKey, { value: failure, expiresAt: Date.now() + CANDLE_CACHE_MS });
    return failure;
  }
  if (!haveContinuousCandles(candles, interval)) {
    const failure = {
      data: null,
      status: missingStatus(
        source,
        "The provider returned an incomplete candle interval; indicators were not calculated from the gapped series.",
        checkedAt,
      ),
    };
    candleCache.set(cacheKey, { value: failure, expiresAt: Date.now() + CANDLE_CACHE_MS });
    return failure;
  }

  const latest = candles[candles.length - 1];
  const observedAt = new Date(latest.closeTime).toISOString();
  const staleThreshold = interval === "1h" ? HOURLY_CANDLE_STALE_MINUTES : DAILY_CANDLE_STALE_HOURS * 60;
  const value = {
    data: candles,
    status: statusFor(source, observedAt, staleThreshold, `${candles.length} completed candles retrieved.`, checkedAt),
  };
  candleCache.set(cacheKey, { value, expiresAt: Date.now() + CANDLE_CACHE_MS });
  return value;
}

export async function getMarketSnapshot(
  asset: AssetCode,
  forceRefresh = false,
): Promise<MarketSnapshot> {
  const [assets, hourlyResult, dailyResult] = await Promise.all([
    getRadarAssets(forceRefresh),
    getCandles(asset, "1h", forceRefresh),
    getCandles(asset, "1d", forceRefresh),
  ]);
  const radarAsset = assets.find((item) => item.symbol === asset);
  const sourceStatuses = radarAsset?.sourceStatuses ?? [
    missingStatus("CoinGecko", "No source data returned."),
    missingStatus("Binance", "No source data returned."),
  ];
  const quote = quoteDetails.get(asset) ?? {
    priceUsd: null,
    priceEurLive: null,
    sourceDeviationPercent: null,
  };

  return {
    asset,
    generatedAt: isoNow(),
    priceEur: quote.priceEurLive,
    priceEurObserved: radarAsset?.priceEur ?? null,
    priceUsd: quote.priceUsd,
    change24hPercent: radarAsset?.change24hPercent ?? null,
    change7dPercent: radarAsset?.change7dPercent ?? null,
    volume24hEur: radarAsset?.volume24hEur ?? null,
    marketCapEur: radarAsset?.marketCapEur ?? null,
    sourceStatuses: [
      ...sourceStatuses,
      hourlyResult.status,
      dailyResult.status,
    ],
    hourlyCandles: hourlyResult.data ?? [],
    dailyCandles: dailyResult.data ?? [],
    hourlyStatus: hourlyResult.status,
    dailyStatus: dailyResult.status,
    sourceDeviationPercent: quote.sourceDeviationPercent,
  };
}
