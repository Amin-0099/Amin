import { and, asc, eq } from "drizzle-orm";
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

type PaperSignalAgent = {
  status: string;
  stance: string;
  dataStatus: string;
  evidence: unknown;
};

export function hasActionablePaperSignal(
  side: "long" | "short",
  report: Pick<FinalReport, "decision" | "confidenceBreakdown"> | null,
  agents: PaperSignalAgent[],
): boolean {
  if (!report || report.confidenceBreakdown.liveAgentCount < 1) return false;
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

function priceStatus(snapshot: MarketSnapshot | undefined): PaperPosition["currentPriceDataStatus"] {
  if (!snapshot) return "missing";
  if (snapshot.priceEur !== null) return "live";
  if (snapshot.priceEurObserved !== null) return "stale";
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
  const entry = asMoney(trade.entryPriceEur);
  const quantity = asMoney(trade.quantity);
  const pnl =
    !isClosed && price !== null
      ? calculateTradePnl(trade.side, quantity, entry, price)
      : isClosed
        ? 0
        : null;
  return {
    positionId: trade.id,
    runId: trade.runId,
    asset: trade.asset as AssetCode,
    side: trade.side as "long" | "short",
    notionalEur: asMoney(trade.notionalEur),
    quantity,
    entryPriceEur: entry,
    currentPriceEur: price,
    currentPriceDataStatus: isClosed ? "missing" : priceStatus(snapshot),
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
  closedTrades: Array<Pick<PaperPosition, "positionId" | "side" | "realizedPnlEur" | "closedAt">>,
  trades: Array<Pick<typeof paperTrades.$inferSelect, "id" | "signalSnapshot">>,
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

  return {
    tradeCount: closedTrades.length,
    winRate: outcomes.length ? (wins.length / outcomes.length) * 100 : null,
    averageWinEur: wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : null,
    averageLossEur: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null,
    maxDrawdownEur: Math.round(maxDrawdown * 100) / 100,
    performanceByAgent: [...agentStats.entries()].map(([agentId, stats]) => ({
      agentId,
      winRate: stats.samples ? (stats.wins / stats.samples) * 100 : null,
      sampleCount: stats.samples,
    })),
  };
}

export async function getPaperPortfolio(accountId: string): Promise<PaperPortfolio> {
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
  const openTrades = trades.filter((trade) => trade.closedAt === null);
  const uniqueAssets = [...new Set(openTrades.map((trade) => trade.asset as AssetCode))];
  const snapshots = new Map<AssetCode, MarketSnapshot>();
  await Promise.all(
    uniqueAssets.map(async (asset) => {
      snapshots.set(asset, await getMarketSnapshot(asset));
    }),
  );

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
          (sum, position) => sum + position.notionalEur + (position.unrealizedPnlEur ?? 0),
          0,
        );
  const realizedPnlEur = closedTrades.reduce(
    (sum, trade) => sum + (trade.realizedPnlEur ?? 0),
    0,
  );
  const startingBalanceEur = asMoney(account?.startingBalanceEur);
  const performance = calculatePaperPerformance(startingBalanceEur, closedTrades, trades);
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
  runId: string;
  side: "long" | "short";
  sizeEur: number;
  stopLossEur: number | null;
  takeProfitEur: number | null;
}): Promise<{ position: PaperPosition; portfolio: PaperPortfolio }> {
  await ensurePaperAccount(input.accountId);
  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.id, input.runId), eq(analysisRuns.accountId, input.accountId)))
    .limit(1);
  if (!run || run.status !== "complete") {
    throw new PaperServiceError("A completed analysis run is required to open a linked demo position.", 409, "ANALYSIS_RUN_REQUIRED");
  }
  const report = run.finalReport as FinalReport | null;
  const agentRows = await db
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
  const asset = run.asset as AssetCode;
  const snapshot = await getMarketSnapshot(asset, true);
  const entryPrice = snapshot.priceEur;
  if (entryPrice === null) {
    throw new PaperServiceError("No fresh EUR price is available. The demo position was not opened.", 503, "LIVE_PRICE_REQUIRED");
  }
  if (input.sizeEur <= 0 || input.sizeEur > 1_000_000) {
    throw new PaperServiceError("Position size must be greater than zero and no more than €1,000,000.", 400, "INVALID_POSITION_SIZE");
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
  const signalSnapshot = {
    runId: run.id,
    asset: run.asset,
    decision: report?.decision ?? "no_clear_signal",
    confidenceScore: run.confidence ?? null,
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

  const created = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.accountId, input.accountId))
      .limit(1);
    const cash = asMoney(account?.cashBalanceEur);
    if (cash < input.sizeEur) {
      throw new PaperServiceError("Insufficient demo cash balance for this position size.", 409, "INSUFFICIENT_DEMO_CASH");
    }
    const [trade] = await tx
      .insert(paperTrades)
      .values({
        accountId: input.accountId,
        runId: input.runId,
        asset,
        side: input.side,
        notionalEur: input.sizeEur.toFixed(2),
        quantity: (input.sizeEur / entryPrice).toFixed(12),
        entryPriceEur: entryPrice.toFixed(10),
        stopLossEur: input.stopLossEur?.toFixed(10) ?? null,
        takeProfitEur: input.takeProfitEur?.toFixed(10) ?? null,
        signalSnapshot,
      })
      .returning();
    await tx
      .update(paperAccounts)
      .set({
        cashBalanceEur: (cash - input.sizeEur).toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, input.accountId));
    return trade;
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
  if (exitPrice === null) {
    throw new PaperServiceError("No fresh EUR price is available. The demo position remains open.", 503, "LIVE_PRICE_REQUIRED");
  }
  const pnl = calculateTradePnl(
    trade.side,
    asMoney(trade.quantity),
    asMoney(trade.entryPriceEur),
    exitPrice,
  );
  const updated = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(paperAccounts)
      .where(eq(paperAccounts.accountId, accountId))
      .limit(1);
    const [closed] = await tx
      .update(paperTrades)
      .set({
        closedAt: new Date(),
        exitPriceEur: exitPrice.toFixed(10),
        realizedPnlEur: pnl.toFixed(2),
        closeReason: "manual_demo_close",
      })
      .where(and(eq(paperTrades.id, positionId), eq(paperTrades.accountId, accountId)))
      .returning();
    await tx
      .update(paperAccounts)
      .set({
        cashBalanceEur: (
          asMoney(account?.cashBalanceEur) +
          asMoney(trade.notionalEur) +
          pnl
        ).toFixed(2),
        updatedAt: new Date(),
      })
      .where(eq(paperAccounts.accountId, accountId));
    return closed;
  });
  return {
    position: mapTrade(updated, snapshot),
    portfolio: await getPaperPortfolio(accountId),
  };
}

export function defaultScoreWeights(): ScoreWeights {
  return DEFAULT_SCORE_WEIGHTS;
}
