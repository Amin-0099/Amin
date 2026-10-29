import { and, asc, count, eq, isNull } from "drizzle-orm";
import type {
  AssetCode,
  DeskSettings,
  FinalReport,
  PaperPerformance,
  PaperPortfolio,
  PaperPosition,
  ScoreWeights,
} from "@workspace/api-zod";
import {
  analysisAgentOutputs,
  analysisRuns,
  db,
  paperAccounts,
  paperSettings,
  paperTrades,
  radarSignals,
} from "@workspace/db";
import { DEFAULT_SCORE_WEIGHTS, ensurePaperAccount } from "./account-settings";
import { getMarketSnapshot, type MarketSnapshot } from "./market-data";

export class PaperServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PaperServiceError";
  }
}

function asMoney(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateTradePnl(
  side: string,
  quantity: number,
  entry: number,
  price: number,
): number {
  return side === "short" ? quantity * (entry - price) : quantity * (price - entry);
}

export function resolvePaperCloseReason(
  side: "long" | "short",
  price: number,
  stopLoss: number | null,
  takeProfit: number | null,
): "stop_loss" | "take_profit" | null {
  if (stopLoss !== null && (side === "long" ? price <= stopLoss : price >= stopLoss)) {
    return "stop_loss";
  }
  if (takeProfit !== null && (side === "long" ? price >= takeProfit : price <= takeProfit)) {
    return "take_profit";
  }
  return null;
}

export function calculatePaperFee(notionalEur: number, feeRateBps: number): number {
  if (
    !Number.isFinite(notionalEur) ||
    notionalEur < 0 ||
    !Number.isInteger(feeRateBps) ||
    feeRateBps < 0 ||
    feeRateBps > 100
  ) throw new RangeError("Invalid demo notional or fee rate.");
  return Math.round((notionalEur * feeRateBps) / 100) / 100;
}

type PaperSignalAgent = {
  status: string;
  stance: string;
  dataStatus: string;
  evidence: unknown;
};

export function hasActionablePaperSignal(
  side: "long" | "short",
  report: {
    decision: FinalReport["decision"];
    dataStatus: FinalReport["dataStatus"];
    confidenceBreakdown: Pick<
      FinalReport["confidenceBreakdown"],
      "liveAgentCount" | "verificationScore"
    >;
  } | null,
  agents: PaperSignalAgent[],
): boolean {
  if (
    !report ||
    report.dataStatus !== "live" ||
    report.confidenceBreakdown.liveAgentCount < 1 ||
    report.confidenceBreakdown.verificationScore < 70
  ) return false;
  const allowedDecisions = side === "long"
    ? ["long", "strong_long"]
    : ["short", "strong_short"];
  if (!allowedDecisions.includes(report.decision)) return false;

  const expectedStance = side === "long" ? "bullish" : "bearish";
  const corroboratingAgents = agents.filter((agent) =>
    agent.status === "complete" &&
    agent.stance === expectedStance &&
    agent.dataStatus === "live" &&
    Array.isArray(agent.evidence) &&
    agent.evidence.length > 0,
  );
  return corroboratingAgents.length >= 2;
}

function priceSources(snapshot: MarketSnapshot | undefined) {
  return (
    snapshot?.sourceStatuses.filter((source) =>
      ["CoinGecko · EUR", "Binance · USDT ticker", "Binance · EURUSDT conversion"].includes(source.source),
    ) ?? []
  );
}

export function getPaperPriceDataStatus(
  snapshot: Pick<MarketSnapshot, "sourceStatuses" | "priceEur" | "priceEurObserved"> | undefined,
): PaperPosition["currentPriceDataStatus"] {
  if (!snapshot) return "missing";
  const liveCoinGeckoPrice = snapshot.sourceStatuses.some(
    (source) => source.source === "CoinGecko · EUR" && source.status === "live",
  );
  const liveBinancePrice = snapshot.sourceStatuses.some(
    (source) => source.source === "Binance · USDT ticker" && source.status === "live",
  );
  const liveBinanceConversion = snapshot.sourceStatuses.some(
    (source) => source.source === "Binance · EURUSDT conversion" && source.status === "live",
  );
  if (
    snapshot.priceEur !== null &&
    (liveCoinGeckoPrice || (liveBinancePrice && liveBinanceConversion))
  ) return "live";
  if (snapshot.priceEurObserved !== null || snapshot.priceEur !== null) return "stale";
  return "missing";
}

function mapTrade(
  trade: typeof paperTrades.$inferSelect,
  snapshot?: MarketSnapshot,
): PaperPosition {
  const isClosed = trade.closedAt !== null;
  const price = isClosed
    ? null
    : snapshot?.priceEur ?? snapshot?.priceEurObserved ?? null;
  const currentPriceDataStatus = isClosed ? "missing" : getPaperPriceDataStatus(snapshot);
  const entry = asMoney(trade.entryPriceEur);
  const quantity = asMoney(trade.quantity);
  const pnl =
    !isClosed && price !== null && currentPriceDataStatus === "live"
      ? calculateTradePnl(trade.side, quantity, entry, price) -
        asMoney(trade.entryFeeEur) -
        calculatePaperFee(quantity * price, trade.feeRateBps)
      : isClosed
        ? 0
        : null;
  return {
    positionId: trade.id,
    runId: trade.runId,
    signalId: trade.signalId,
    asset: trade.asset as AssetCode,
    side: trade.side as "long" | "short",
    notionalEur: asMoney(trade.notionalEur),
    quantity,
    entryPriceEur: entry,
    feeRateBps: trade.feeRateBps,
    entryFeeEur: asMoney(trade.entryFeeEur),
    exitFeeEur: asMoney(trade.exitFeeEur),
    currentPriceEur: price,
    currentPriceDataStatus,
    priceSources: isClosed ? [] : priceSources(snapshot),
    stopLossEur: trade.stopLossEur === null ? null : asMoney(trade.stopLossEur),
    takeProfitEur: trade.takeProfitEur === null ? null : asMoney(trade.takeProfitEur),
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt?.toISOString() ?? null,
    exitPriceEur: trade.exitPriceEur === null ? null : asMoney(trade.exitPriceEur),
    unrealizedPnlEur: pnl,
    realizedPnlEur: trade.realizedPnlEur === null ? null : asMoney(trade.realizedPnlEur),
    status: isClosed ? "closed" : "open",
    closeReason: trade.closeReason,
  };
}

function readDirectionalAgents(signalSnapshot: Record<string, unknown>): Array<{ id: string; stance: string }> {
  const rows = signalSnapshot.agentResults;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const id = typeof item.agentId === "string" ? item.agentId : null;
    const stance = typeof item.stance === "string" ? item.stance : null;
    const dataStatus = item.dataStatus;
    return id && (stance === "bullish" || stance === "bearish") && dataStatus === "live"
      ? [{ id, stance }]
      : [];
  });
}

export function calculatePaperPerformance(
  startingBalance: number,
  closedTrades: Array<
    Pick<PaperPosition, "positionId" | "side" | "realizedPnlEur" | "closedAt"> &
    Partial<Pick<PaperPosition, "asset">>
  >,
  trades: Array<{
    id: string;
    signalSnapshot: Record<string, unknown>;
    signalId?: string | null;
    asset?: string;
  }>,
  signalCountOverride?: number,
): PaperPerformance {
  const outcomes = closedTrades
    .map((trade) => trade.realizedPnlEur)
    .filter((value): value is number => value !== null);
  const wins = outcomes.filter((value) => value > 0);
  const losses = outcomes.filter((value) => value < 0);
  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  const sorted = [...closedTrades].sort(
    (left, right) => Date.parse(left.closedAt ?? "") - Date.parse(right.closedAt ?? ""),
  );
  for (const trade of sorted) {
    balance += trade.realizedPnlEur ?? 0;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);
  }

  const agentStats = new Map<string, { wins: number; samples: number }>();
  const byPosition = new Map(trades.map((trade) => [trade.id, trade]));
  const performanceRows = closedTrades.flatMap((trade) => {
    const raw = byPosition.get(trade.positionId);
    if (!raw) return [];
    const snapshot = raw.signalSnapshot.signalSnapshot &&
      typeof raw.signalSnapshot.signalSnapshot === "object"
      ? raw.signalSnapshot.signalSnapshot as Record<string, unknown>
      : raw.signalSnapshot;
    const finalReport = snapshot.finalReport && typeof snapshot.finalReport === "object"
      ? snapshot.finalReport as Record<string, unknown>
      : snapshot;
    const stance = typeof snapshot.stance === "string"
      ? snapshot.stance
      : typeof finalReport.stance === "string" ? finalReport.stance : "unknown";
    const signalType = typeof snapshot.decision === "string"
      ? snapshot.decision
      : typeof finalReport.decision === "string" ? finalReport.decision : "unknown";
    const closedAt = trade.closedAt ? new Date(trade.closedAt) : null;
    return [{
      asset: raw.asset ?? (typeof snapshot.asset === "string" ? snapshot.asset : "unknown"),
      stance,
      signalType,
      timeWindow: closedAt && Number.isFinite(closedAt.getTime())
        ? closedAt.toISOString().slice(0, 7)
        : "unknown",
      pnl: trade.realizedPnlEur ?? 0,
    }];
  });
  const buildBreakdown = (keyOf: (row: typeof performanceRows[number]) => string) => {
    const groups = new Map<string, number[]>();
    for (const row of performanceRows) {
      const key = keyOf(row);
      groups.set(key, [...(groups.get(key) ?? []), row.pnl]);
    }
    return [...groups.entries()].map(([key, values]) => {
      const groupWins = values.filter((value) => value > 0);
      const groupLosses = values.filter((value) => value < 0);
      const grossProfit = groupWins.reduce((sum, value) => sum + value, 0);
      const grossLoss = Math.abs(groupLosses.reduce((sum, value) => sum + value, 0));
      const sufficientSample = values.length >= 5;
      return {
        status: sufficientSample ? "measured" as const : "insufficient_data" as const,
        key,
        tradeCount: values.length,
        winnerCount: groupWins.length,
        loserCount: groupLosses.length,
        winRate: sufficientSample ? (groupWins.length / values.length) * 100 : null,
        totalPnlEur: values.reduce((sum, value) => sum + value, 0),
        averageWinEur: sufficientSample && groupWins.length ? grossProfit / groupWins.length : null,
        averageLossEur: sufficientSample && groupLosses.length
          ? groupLosses.reduce((sum, value) => sum + value, 0) / groupLosses.length
          : null,
        profitFactor: sufficientSample && grossLoss > 0 ? grossProfit / grossLoss : null,
      };
    }).sort((left, right) => left.key.localeCompare(right.key));
  };
  for (const tradeView of closedTrades) {
    const raw = byPosition.get(tradeView.positionId);
    if (!raw) continue;
    const pnl = tradeView.realizedPnlEur ?? 0;
    const underlyingMove = tradeView.side === "short" ? -pnl : pnl;
    for (const agent of readDirectionalAgents(raw.signalSnapshot)) {
      const stats = agentStats.get(agent.id) ?? { wins: 0, samples: 0 };
      stats.samples += 1;
      if (
        (agent.stance === "bullish" && underlyingMove > 0) ||
        (agent.stance === "bearish" && underlyingMove < 0)
      ) {
        stats.wins += 1;
      }
      agentStats.set(agent.id, stats);
    }
  }

  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    status: outcomes.length >= 5 ? "measured" : "insufficient_data",
    signalCount: signalCountOverride ?? new Set(trades.flatMap((trade) =>
      trade.signalId ? [trade.signalId] : [],
    )).size,
    tradeCount: closedTrades.length,
    winnerCount: wins.length,
    loserCount: losses.length,
    winRate: outcomes.length >= 5 ? (wins.length / outcomes.length) * 100 : null,
    totalPnlEur: outcomes.reduce((sum, value) => sum + value, 0),
    profitFactor: outcomes.length >= 5 && grossLoss > 0 ? grossProfit / grossLoss : null,
    averageWinEur: outcomes.length >= 5 && wins.length ? grossProfit / wins.length : null,
    averageLossEur: outcomes.length >= 5 && losses.length
      ? losses.reduce((sum, value) => sum + value, 0) / losses.length
      : null,
    maxDrawdownEur: Math.round(maxDrawdown * 100) / 100,
    byAsset: buildBreakdown((row) => row.asset),
    byStance: buildBreakdown((row) => row.stance),
    bySignalType: buildBreakdown((row) => row.signalType),
    byTimeWindow: buildBreakdown((row) => row.timeWindow),
    performanceByAgent: [...agentStats.entries()].map(([agentId, stats]) => ({
      agentId,
      winRate: stats.samples >= 5 ? (stats.wins / stats.samples) * 100 : null,
      sampleCount: stats.samples,
    })),
  };
}

export async function getPaperPortfolio(accountId: string): Promise<PaperPortfolio> {
  await ensurePaperAccount(accountId);
  let trades = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.accountId, accountId))
    .orderBy(asc(paperTrades.openedAt));
  const initialOpenTrades = trades.filter((trade) => trade.closedAt === null);
  const uniqueAssets = [...new Set(initialOpenTrades.map((trade) => trade.asset as AssetCode))];
  const snapshots = new Map<AssetCode, MarketSnapshot>();
  await Promise.all(
    uniqueAssets.map(async (asset) => {
      snapshots.set(asset, await getMarketSnapshot(asset));
    }),
  );

  for (const trade of initialOpenTrades) {
    const snapshot = snapshots.get(trade.asset as AssetCode);
    const price = snapshot?.priceEur;
    if (
      price === null ||
      price === undefined ||
      getPaperPriceDataStatus(snapshot) !== "live"
    ) continue;
    const closeReason = resolvePaperCloseReason(
      trade.side as "long" | "short",
      price,
      trade.stopLossEur === null ? null : asMoney(trade.stopLossEur),
      trade.takeProfitEur === null ? null : asMoney(trade.takeProfitEur),
    );
    if (closeReason) {
      const closed = await settlePaperTrade(trade, price, closeReason);
      trades = trades.map((item) => item.id === closed.id ? closed : item);
    }
  }
  const [account] = await db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.accountId, accountId))
    .limit(1);
  const openTrades = trades.filter((trade) => trade.closedAt === null);
  const positions = openTrades.map((trade) =>
    mapTrade(trade, snapshots.get(trade.asset as AssetCode)),
  );
  const closedTrades = trades
    .filter((trade) => trade.closedAt !== null)
    .map((trade) => mapTrade(trade));
  const openValuationComplete = positions.every((position) => position.unrealizedPnlEur !== null);
  const unrealizedPnlEur = openValuationComplete
    ? positions.reduce((sum, position) => sum + (position.unrealizedPnlEur ?? 0), 0)
    : null;
  const cashBalanceEur = asMoney(account?.cashBalanceEur);
  const equityEur =
    unrealizedPnlEur === null
      ? null
      : cashBalanceEur +
        positions.reduce(
            (sum, position) =>
              sum +
              position.notionalEur +
              calculateTradePnl(
                position.side,
                position.quantity,
                position.entryPriceEur,
                position.currentPriceEur!,
              ) -
              position.exitFeeEur,
            0,
          );
  const realizedPnlEur = closedTrades.reduce(
    (sum, trade) => sum + (trade.realizedPnlEur ?? 0),
    0,
  );
  const startingBalanceEur = asMoney(account?.startingBalanceEur);
  const [signalCountResult] = await db.select({ value: count() }).from(radarSignals);
  const performance = calculatePaperPerformance(
    startingBalanceEur,
    closedTrades,
    trades,
    signalCountResult?.value ?? 0,
  );
  const currentDrawdown =
    equityEur === null || startingBalanceEur <= 0
      ? null
      : Math.max(0, ((startingBalanceEur - equityEur) / startingBalanceEur) * 100);

  return {
    accountId,
    currency: "EUR",
    startingBalanceEur,
    cashBalanceEur,
    equityEur,
    realizedPnlEur,
    unrealizedPnlEur,
    drawdownPercent: currentDrawdown ?? 0,
    positions,
    closedTrades: closedTrades.reverse(),
    performance,
  };
}

function validateWeights(weights: ScoreWeights): ScoreWeights {
  const entries = Object.values(weights);
  if (entries.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new PaperServiceError("Every score weight must be between 0 and 100.", 400, "INVALID_SCORE_WEIGHTS");
  }
  if (entries.reduce((sum, value) => sum + value, 0) <= 0) {
    throw new PaperServiceError("At least one score weight must be greater than zero.", 400, "INVALID_SCORE_WEIGHTS");
  }
  return weights;
}

export async function updateDeskSettings(
  accountId: string,
  input: { startingBalanceEur: number; scoreWeights: ScoreWeights },
): Promise<DeskSettings> {
  await ensurePaperAccount(accountId);
  const weights = validateWeights(input.scoreWeights);
  const [existingAccount] = await db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.accountId, accountId))
    .limit(1);
  const existingTrades = await db
    .select({ id: paperTrades.id })
    .from(paperTrades)
    .where(eq(paperTrades.accountId, accountId))
    .limit(1);
  if (
    existingTrades.length &&
    Number(existingAccount?.startingBalanceEur) !== input.startingBalanceEur
  ) {
    throw new PaperServiceError(
      "Starting balance cannot change while trade history exists. Reset the demo portfolio first.",
      409,
      "PORTFOLIO_RESET_REQUIRED",
    );
  }
  await db.transaction(async (tx) => {
    await tx
      .update(paperAccounts)
      .set({
        startingBalanceEur: input.startingBalanceEur.toFixed(2),
        cashBalanceEur:
          existingTrades.length === 0
            ? input.startingBalanceEur.toFixed(2)
            : existingAccount?.cashBalanceEur ?? input.startingBalanceEur.toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, accountId));
    await tx
      .update(paperSettings)
      .set({ scoreWeights: weights, updatedAt: new Date() })
      .where(eq(paperSettings.accountId, accountId));
  });
  return {
    accountId,
    startingBalanceEur: input.startingBalanceEur,
    scoreWeights: weights,
  };
}

export async function resetPaperPortfolio(
  accountId: string,
  startingBalanceEur: number,
): Promise<PaperPortfolio> {
  if (!Number.isFinite(startingBalanceEur) || startingBalanceEur < 0 || startingBalanceEur > 1_000_000) {
    throw new PaperServiceError("Starting balance must be between €0 and €1,000,000.", 400, "INVALID_STARTING_BALANCE");
  }
  await ensurePaperAccount(accountId);
  await db.transaction(async (tx) => {
    await tx.delete(paperTrades).where(eq(paperTrades.accountId, accountId));
    await tx
      .update(paperAccounts)
      .set({
        startingBalanceEur: startingBalanceEur.toFixed(2),
        cashBalanceEur: startingBalanceEur.toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, accountId));
  });
  return getPaperPortfolio(accountId);
}

export async function openPaperPosition(input: {
  accountId: string;
  runId?: string | null;
  signalId?: string | null;
  side: "long" | "short";
  sizeEur: number;
  stopLossEur: number | null;
  takeProfitEur: number | null;
  feeRateBps?: number;
}): Promise<{ position: PaperPosition; portfolio: PaperPortfolio }> {
  const hasRun = Boolean(input.runId);
  const hasSignal = Boolean(input.signalId);
  if (hasRun === hasSignal) {
    throw new PaperServiceError(
      "Provide exactly one completed analysis run or recorded radar signal.",
      400,
      "INVALID_SIGNAL_REFERENCE",
    );
  }
  const feeRateBps = input.feeRateBps ?? 10;
  if (!Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 100) {
    throw new PaperServiceError("Demo fee rate must be between 0 and 100 basis points.", 400, "INVALID_FEE_RATE");
  }
  const notionalEur = Math.round(input.sizeEur * 100) / 100;
  if (!Number.isFinite(notionalEur) || notionalEur <= 0 || notionalEur > 1_000_000) {
    throw new PaperServiceError("Position size must be greater than zero and no more than €1,000,000.", 400, "INVALID_POSITION_SIZE");
  }
  await ensurePaperAccount(input.accountId);
  let run: typeof analysisRuns.$inferSelect | null = null;
  let report: FinalReport | null = null;
  let agentRows: (typeof analysisAgentOutputs.$inferSelect)[] = [];
  let recordedSignal: typeof radarSignals.$inferSelect | null = null;
  if (input.runId) {
    const [foundRun] = await db
      .select()
      .from(analysisRuns)
      .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)))
      .limit(1);
    if (!foundRun || foundRun.status !== "complete") {
      throw new PaperServiceError("A completed analysis run is required to open a linked demo position.", 409, "ANALYSIS_RUN_REQUIRED");
    }
    run = foundRun;
    report = run.finalReport as FinalReport | null;
    agentRows = await db
      .select()
      .from(analysisAgentOutputs)
      .where(eq(analysisAgentOutputs.runId, input.runId));
    if (!hasActionablePaperSignal(input.side, report, agentRows)) {
      throw new PaperServiceError(
        "A matching live-data-backed analysis signal is required to open this demo position.",
        409,
        "PAPER_SIGNAL_NOT_ACTIONABLE",
      );
    }
  } else if (input.signalId) {
    const [foundSignal] = await db
      .select()
      .from(radarSignals)
      .where(eq(radarSignals.id, input.signalId))
      .limit(1);
    if (!foundSignal) {
      throw new PaperServiceError("Recorded radar signal not found.", 404, "RADAR_SIGNAL_NOT_FOUND");
    }
    recordedSignal = foundSignal;
    const expectedStance = input.side === "long" ? "bullish" : "bearish";
    const saved = recordedSignal.snapshot;
    const signalAgeMs = Date.now() - recordedSignal.observedAt.getTime();
    const confidenceBreakdown = saved.confidenceBreakdown;
    const verificationScore = confidenceBreakdown &&
      typeof confidenceBreakdown === "object" &&
      "verificationScore" in confidenceBreakdown &&
      typeof confidenceBreakdown.verificationScore === "number"
      ? confidenceBreakdown.verificationScore
      : 0;
    if (
      recordedSignal.dataStatus !== "live" ||
      signalAgeMs < 0 ||
      signalAgeMs > 90 * 60 * 1_000 ||
      recordedSignal.stance !== expectedStance ||
      verificationScore < 70 ||
      !Array.isArray(saved.evidence) ||
      saved.evidence.length === 0
    ) {
      throw new PaperServiceError(
        "A matching live, verified radar signal is required for a linked paper position.",
        409,
        "PAPER_SIGNAL_NOT_ACTIONABLE",
      );
    }
    const duplicate = await db
      .select({ id: paperTrades.id })
      .from(paperTrades)
      .where(and(
        eq(paperTrades.accountId, input.accountId),
        eq(paperTrades.signalId, recordedSignal.id),
      ))
      .limit(1);
    if (duplicate.length) {
      throw new PaperServiceError(
        "This radar signal already has a paper position in the account.",
        409,
        "SIGNAL_ALREADY_TRADED",
      );
    }
  }
  const asset = (run?.asset ?? recordedSignal?.asset) as AssetCode;
  const snapshot = await getMarketSnapshot(asset, true);
  const entryPrice = snapshot.priceEur;
  if (entryPrice === null || getPaperPriceDataStatus(snapshot) !== "live") {
    throw new PaperServiceError("No fresh EUR price is available. The demo position was not opened.", 503, "LIVE_PRICE_REQUIRED");
  }
  if (
    input.stopLossEur !== null &&
    (input.stopLossEur <= 0 ||
      (input.side === "long" && input.stopLossEur >= entryPrice) ||
      (input.side === "short" && input.stopLossEur <= entryPrice))
  ) {
    throw new PaperServiceError("Stop-loss must be positive and below entry for long, above entry for short.", 400, "INVALID_STOP_LOSS");
  }
  if (
    input.takeProfitEur !== null &&
    (input.takeProfitEur <= 0 ||
      (input.side === "long" && input.takeProfitEur <= entryPrice) ||
      (input.side === "short" && input.takeProfitEur >= entryPrice))
  ) {
    throw new PaperServiceError("Take-profit must be positive and above entry for long, below entry for short.", 400, "INVALID_TAKE_PROFIT");
  }
  const signalSnapshot = recordedSignal
    ? {
        signalId: recordedSignal.id,
        signalSnapshot: recordedSignal.snapshot,
        stance: recordedSignal.stance,
        decision: recordedSignal.signalType,
        confidenceScore: recordedSignal.confidenceScore,
        asset: recordedSignal.asset,
      }
    : {
        runId: run!.id,
        asset: run!.asset,
        decision: report?.decision ?? "no_clear_signal",
        stance: report?.stance ?? "not_evaluable",
        confidenceScore: run!.confidence ?? null,
        riskScore: report?.riskScore ?? null,
        finalReport: report,
        agentResults: agentRows.map((agent) => ({
          agentId: agent.agentId,
          status: agent.status,
          stance: agent.stance,
          dataStatus: agent.dataStatus,
          confidence: agent.confidence,
          summary: agent.summary,
          evidence: agent.evidence,
          dataSources: agent.dataSources,
          timestamp: agent.timestamp.toISOString(),
        })),
      };
  const entryFeeEur = calculatePaperFee(notionalEur, feeRateBps);

  const created = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.accountId, input.accountId))
      .for("update")
      .limit(1);
    const cash = asMoney(account?.cashBalanceEur);
    if (cash < notionalEur + entryFeeEur) {
      throw new PaperServiceError("Insufficient demo cash balance for this position size.", 409, "INSUFFICIENT_DEMO_CASH");
    }
    const [trade] = await tx
      .insert(paperTrades)
      .values({
        accountId: input.accountId,
        runId: run?.id ?? null,
        signalId: recordedSignal?.id ?? null,
        asset,
        side: input.side,
        notionalEur: notionalEur.toFixed(2),
        quantity: (notionalEur / entryPrice).toFixed(12),
        entryPriceEur: entryPrice.toFixed(10),
        feeRateBps,
        entryFeeEur: entryFeeEur.toFixed(2),
        exitFeeEur: "0",
        stopLossEur: input.stopLossEur?.toFixed(10) ?? null,
        takeProfitEur: input.takeProfitEur?.toFixed(10) ?? null,
        signalSnapshot,
      })
      .returning();
    await tx
      .update(paperAccounts)
      .set({
        cashBalanceEur: (cash - notionalEur - entryFeeEur).toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, input.accountId));
    return trade;
  }).catch((error: unknown) => {
    if (
      recordedSignal &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new PaperServiceError(
        "This radar signal already has a paper position in the account.",
        409,
        "SIGNAL_ALREADY_TRADED",
      );
    }
    throw error;
  });

  const portfolio = await getPaperPortfolio(input.accountId);
  return {
    position: mapTrade(created, snapshot),
    portfolio,
  };
}

export async function closePaperPosition(
  positionId: string,
  accountId: string,
): Promise<{ position: PaperPosition; portfolio: PaperPortfolio }> {
  const [trade] = await db
    .select()
    .from(paperTrades)
    .where(and(eq(paperTrades.id, positionId), eq(paperTrades.accountId, accountId)))
    .limit(1);
  if (!trade) {
    throw new PaperServiceError("Demo position not found.", 404, "POSITION_NOT_FOUND");
  }
  if (trade.closedAt) {
    throw new PaperServiceError("This demo position is already closed.", 409, "POSITION_ALREADY_CLOSED");
  }
  const snapshot = await getMarketSnapshot(trade.asset as AssetCode, true);
  const exitPrice = snapshot.priceEur;
  if (exitPrice === null || getPaperPriceDataStatus(snapshot) !== "live") {
    throw new PaperServiceError("No fresh EUR price is available. The demo position remains open.", 503, "LIVE_PRICE_REQUIRED");
  }
  const updated = await settlePaperTrade(trade, exitPrice, "manual_demo_close");
  return {
    position: mapTrade(updated, snapshot),
    portfolio: await getPaperPortfolio(accountId),
  };
}

async function settlePaperTrade(
  trade: typeof paperTrades.$inferSelect,
  exitPrice: number,
  closeReason: string,
): Promise<typeof paperTrades.$inferSelect> {
  const quantity = asMoney(trade.quantity);
  const grossPnl = calculateTradePnl(
    trade.side,
    quantity,
    asMoney(trade.entryPriceEur),
    exitPrice,
  );
  const exitFeeEur = calculatePaperFee(quantity * exitPrice, trade.feeRateBps);
  const realizedPnl = grossPnl - asMoney(trade.entryFeeEur) - exitFeeEur;
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.accountId, trade.accountId))
      .for("update")
      .limit(1);
    const [closed] = await tx
      .update(paperTrades)
      .set({
        closedAt: new Date(),
        exitPriceEur: exitPrice.toFixed(10),
        exitFeeEur: exitFeeEur.toFixed(2),
        realizedPnlEur: realizedPnl.toFixed(2),
        closeReason,
      })
      .where(and(
        eq(paperTrades.id, trade.id),
        eq(paperTrades.accountId, trade.accountId),
        isNull(paperTrades.closedAt),
      ))
      .returning();
    if (!closed) {
      throw new PaperServiceError("This demo position is already closed.", 409, "POSITION_ALREADY_CLOSED");
    }
    await tx
      .update(paperAccounts)
      .set({
        cashBalanceEur: (
          asMoney(account?.cashBalanceEur) +
          asMoney(trade.notionalEur) +
          grossPnl -
          exitFeeEur
        ).toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, trade.accountId));
    return closed;
  });
}

export async function getPaperPerformance(accountId: string): Promise<PaperPerformance> {
  await ensurePaperAccount(accountId);
  const [account] = await db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.accountId, accountId))
    .limit(1);
  const trades = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.accountId, accountId))
    .orderBy(asc(paperTrades.openedAt));
  const closedTrades = trades
    .filter((trade) => trade.closedAt !== null)
    .map((trade) => mapTrade(trade));
  const [signalCountResult] = await db.select({ value: count() }).from(radarSignals);
  return calculatePaperPerformance(
    asMoney(account?.startingBalanceEur),
    closedTrades,
    trades,
    signalCountResult?.value ?? 0,
  );
}

export function defaultScoreWeights(): ScoreWeights {
  return DEFAULT_SCORE_WEIGHTS;
}
