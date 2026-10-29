import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  Clock3,
  Command,
  FileText,
  Layers3,
  Menu,
  MessageSquareText,
  RotateCcw,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import {
  getAnalysisRun,
  getPaperPortfolio,
  getRadar,
  getRadarPerformance,
  getRadarSignals,
  openPaperTrade,
  closePaperTrade,
  startAnalysisRun,
  stopAnalysisRun,
  type AgentResult,
  type AnalysisRun,
  type AssetCode,
  type FinalReport,
  type MarketAsset,
  type PaperPortfolio,
  type RadarSignalSnapshot,
  type RadarErrorSource,
  type RadarPerformanceItem,
} from "@workspace/api-client-react";
import "./index.css";

type ActivityEntry = {
  id: number;
  agent: string;
  message: string;
  time: string;
  kind?: "error";
};

type AgentCard = {
  id: string;
  name: string;
  specialty: string;
  status: "Idle" | "Working" | "Complete" | "Error";
  result: string;
  dataStatus?: "live" | "stale" | "missing";
};

type ReportView = FinalReport & { question: string };

const assets: AssetCode[] = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "LTC",
];

const agentDefinitions = [
  ["master", "Master Agent", "Orchestration & synthesis"],
  ["market-structure", "Market Structure", "Cross-source quote analysis"],
  ["technical-analyst", "Technical Analyst", "OHLCV indicators"],
  ["momentum-scanner", "Momentum Scanner", "Price, volume & trend"],
  ["volume-analyst", "Volume Analyst", "Completed candle volume"],
  ["news-analyst", "News Analyst", "News sources"],
  ["macro-analyst", "Macro Analyst", "Macroeconomic data"],
  ["sentiment-analyst", "Sentiment Analyst", "Sentiment sources"],
  ["social-sentiment", "Social Sentiment", "Social platforms"],
  ["on-chain-analyst", "On-Chain Analyst", "Blockchain data"],
  ["risk-analyst", "Risk Analyst", "Volatility & drawdown"],
  ["market-scanner", "Market Scanner", "Evidence-referenced Gemini review"],
  ["verification", "Verification Agent", "Raw-data cross-check"],
  ["final-decision", "Final Decision Agent", "Evidence-weighted synthesis"],
] as const;

function idleAgents(): AgentCard[] {
  return agentDefinitions.map(([id, name, specialty]) => ({
    id,
    name,
    specialty,
    status: "Idle",
    result: "",
  }));
}

function mapAgentResults(results: AgentResult[]): AgentCard[] {
  const byId = new Map(results.map((result) => [result.agentId, result]));
  return agentDefinitions.map(([id, name, specialty]) => {
    const result = byId.get(id);
    if (!result) return { id, name, specialty, status: "Idle", result: "" };
    const status = result.status === "working"
      ? "Working"
      : result.status === "error"
        ? "Error"
        : result.status === "complete"
          ? "Complete"
          : "Idle";
    const resultText = result.stance === "not_evaluable"
      ? `${result.summary} Data: ${result.dataStatus}.`
      : `${result.summary} Stance: ${result.stance}. Data: ${result.dataStatus}.`;
    return {
      id,
      name: result.displayName || name,
      specialty,
      status,
      result: resultText,
      dataStatus: result.dataStatus,
    };
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const responseData = "data" in error ? error.data : undefined;
    if (
      responseData &&
      typeof responseData === "object" &&
      "error" in responseData &&
      typeof responseData.error === "string"
    ) return responseData.error;
    if ("message" in error && typeof error.message === "string") return error.message;
  }
  return "The server request failed. No analysis result was substituted.";
}

function signalStateLabel(state: FinalReport["radarState"]): string {
  if (state === "attractive_risk_reward") return "🟢 CHANCE-RISIKO ATTRAKTIV";
  if (state === "observe") return "🟡 BEOBACHTEN";
  return "🔴 FÜSSE STILL HALTEN";
}

function formatPrice(value: number | null): string {
  return value === null
    ? "missing"
    : new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: value < 1 ? 6 : 2,
      }).format(value);
}

function formatPercent(value: number | null): string {
  return value === null ? "missing" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "missing";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("de-DE", { timeZone: "UTC", timeZoneName: "short" })
    : "invalid timestamp";
}

function sourceStatusLabel(status: string): string {
  return status === "live" ? "LIVE" : status === "stale" ? "STALE" : "MISSING";
}

function getAccountId(): string {
  const storageKey = "amin-ai-desk:paper-account-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return existing;
  }
  const accountId = window.crypto.randomUUID();
  window.localStorage.setItem(storageKey, accountId);
  return accountId;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The request was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function mapActivity(run: AnalysisRun): ActivityEntry[] {
  return [...run.activity].reverse().map((entry) => ({
    id: entry.id,
    agent: entry.agent,
    message: entry.message,
    time: new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    ...(entry.kind === "error" ? { kind: "error" as const } : {}),
  }));
}

function RadarTable({ items }: { items: MarketAsset[] }) {
  return (
    <div className="radar-table-wrap">
      <table className="radar-table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Price (EUR)</th>
            <th>24h</th>
            <th>24h volume (EUR)</th>
            <th>Momentum / 100</th>
            <th>Stance</th>
            <th>Signal</th>
            <th>Invalidation</th>
            <th>Timestamp & sources</th>
          </tr>
        </thead>
        <tbody>
          {items.map((asset) => (
            <tr key={asset.symbol}>
              <td><strong>{asset.symbol}</strong><small>{asset.name}</small></td>
              <td>{formatPrice(asset.priceEur)}</td>
              <td>{formatPercent(asset.change24hPercent)}</td>
              <td>{asset.volume24hEur === null ? "missing" : formatPrice(asset.volume24hEur)}</td>
              <td>{asset.momentumRating === null ? "missing" : asset.momentumRating.toFixed(1)}</td>
              <td>{asset.signal?.stance ?? "not_evaluable"}</td>
              <td>
                <span className={`radar-signal ${asset.signal?.radarState ?? "stand_aside"}`}>
                  {asset.signal ? signalStateLabel(asset.signal.radarState) : "🔴 FÜSSE STILL HALTEN"}
                </span>
              </td>
              <td>{asset.signal?.invalidation ?? "No verified invalidation."}</td>
              <td>
                <span className={`data-status ${asset.dataStatus}`}>{sourceStatusLabel(asset.dataStatus)}</span>
                <small>
                  {asset.sourceStatuses.map((source) => `${source.source}: ${sourceStatusLabel(source.status)}`).join(" · ") || "No sources"}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerformanceTable({
  items,
  errorSources,
}: {
  items: RadarPerformanceItem[];
  errorSources: RadarErrorSource[];
}) {
  return (
    <>
      {items.length === 0
        ? <p className="empty-performance">No evaluated outcomes yet. Results appear only after a recorded 1h, 24h, or 7d horizon has elapsed and fresh candles are available.</p>
        : <div className="radar-table-wrap">
            <table className="radar-table performance-table">
              <thead><tr><th>Asset</th><th>Signal type</th><th>Horizon</th><th>Samples</th><th>Status</th><th>Directional samples</th><th>Hit rate</th><th>Average return</th></tr></thead>
              <tbody>{items.map((item) => (
                <tr key={`${item.asset}:${item.signalType}:${item.stance}:${item.horizonHours}`}>
                  <td><strong>{item.asset}</strong></td><td>{item.signalType} · {item.stance}</td>
                  <td>{item.horizonHours === 168 ? "7d" : `${item.horizonHours}h`}</td>
                  <td>{item.sampleCount}</td><td>{item.status.replaceAll("_", " ")}</td><td>{item.directionalSampleCount}</td>
                  <td>{item.hitRatePercent === null ? "n/a" : `${item.hitRatePercent.toFixed(1)}%`}</td>
                  <td>{formatPercent(item.averageReturnPercent)}</td>
                </tr>
              ))}</tbody>
            </table>
            <p className="performance-caveat">Rates and average returns are withheld until at least five completed observations per group. These historical samples are not a forecast or guaranteed hit rate.</p>
          </div>}
      <div className="error-source-list">
        <strong>Observed signal quality issues</strong>
        {errorSources.length
          ? errorSources.map((item) => <span key={item.category}>{item.category.replaceAll("_", " ")}: {item.signalCount} signals</span>)
          : <span>No classified data-quality or signal conflicts in stored records.</span>}
      </div>
    </>
  );
}

function PaperTradingSection({
  accountId,
  portfolio,
  portfolioError,
  signals,
  signalError,
  sizeEur,
  feeRateBps,
  busyId,
  onSizeChange,
  onFeeRateChange,
  onOpenSignal,
  onClosePosition,
}: {
  accountId: string | null;
  portfolio: PaperPortfolio | null;
  portfolioError: string | null;
  signals: RadarSignalSnapshot[];
  signalError: string | null;
  sizeEur: number;
  feeRateBps: number;
  busyId: string | null;
  onSizeChange: (value: number) => void;
  onFeeRateChange: (value: number) => void;
  onOpenSignal: (signal: RadarSignalSnapshot) => void;
  onClosePosition: (positionId: string) => void;
}) {
  const performance = portfolio?.performance;
  const performanceGroups = performance ? [
    { label: "By asset", rows: performance.byAsset },
    { label: "By stance", rows: performance.byStance },
    { label: "By signal type", rows: performance.bySignalType },
    { label: "By close month", rows: performance.byTimeWindow },
  ] : [];
  return (
    <section className="paper-section" id="paper-trading">
      <div className="section-heading">
        <div>
          <div className="section-kicker"><span className="step-index">05</span><span>VIRTUAL POSITIONS · NO EXCHANGE ORDERS</span></div>
          <h2>Paper trading</h2>
        </div>
        <span className="prototype-pill paper-only-pill"><span /> PAPER / DEMO ONLY</span>
      </div>
      <p className="paper-disclaimer">All entries, exits, fees, balances, and P&amp;L below are virtual. No real orders, wallet, or funds are connected.</p>
      {portfolioError && <p className="inline-error" role="alert">Paper portfolio unavailable: {portfolioError}</p>}
      {!accountId && <p className="inline-error">A persistent paper account is required to load positions.</p>}
      {portfolio && (
        <>
          <div className="paper-metrics">
            <article><span>VIRTUAL START BALANCE</span><strong>{formatPrice(portfolio.startingBalanceEur)}</strong></article>
            <article><span>AVAILABLE DEMO CASH</span><strong>{formatPrice(portfolio.cashBalanceEur)}</strong></article>
            <article><span>VIRTUAL EQUITY</span><strong>{portfolio.equityEur === null ? "missing live valuation" : formatPrice(portfolio.equityEur)}</strong></article>
            <article><span>REALIZED / UNREALIZED P&amp;L</span><strong>{formatPrice(portfolio.realizedPnlEur)} / {portfolio.unrealizedPnlEur === null ? "missing" : formatPrice(portfolio.unrealizedPnlEur)}</strong></article>
          </div>
          <div className="paper-controls">
            <label>Paper size (EUR)<input type="number" min="1" max="1000000" step="1" value={sizeEur} onChange={(event) => onSizeChange(Number(event.target.value))} /></label>
            <label>Demo fee assumption (bps / side)<input type="number" min="0" max="100" step="1" value={feeRateBps} onChange={(event) => onFeeRateChange(Number(event.target.value))} /></label>
            <span>Fees are charged virtually on both entry and exit.</span>
          </div>
          {portfolio.performance.status === "insufficient_data"
            ? <>
                <p className="empty-performance">Insufficient statistical sample ({performance?.tradeCount ?? 0}/5 completed trades). Rates, averages, and profit factor are withheld; displayed counts and P&amp;L are observed paper results only.</p>
                <div className="paper-performance-grid">
                  <article><span>SAVED RADAR SIGNALS</span><strong>{performance?.signalCount ?? 0}</strong></article>
                  <article><span>CLOSED TRADES</span><strong>{performance?.tradeCount ?? 0}</strong></article>
                  <article><span>WINNERS / LOSERS</span><strong>{performance?.winnerCount ?? 0} / {performance?.loserCount ?? 0}</strong></article>
                  <article><span>OBSERVED NET P&amp;L</span><strong>{formatPrice(performance?.totalPnlEur ?? 0)}</strong></article>
                </div>
              </>
            : <div className="paper-performance-grid">
                <article><span>SAVED RADAR SIGNALS</span><strong>{performance?.signalCount ?? 0}</strong></article>
                <article><span>CLOSED TRADES</span><strong>{performance?.tradeCount ?? 0}</strong></article>
                <article><span>WINNERS / LOSERS</span><strong>{performance?.winnerCount ?? 0} / {performance?.loserCount ?? 0}</strong></article>
                <article><span>HISTORICAL WIN RATE</span><strong>{performance?.winRate === null ? "insufficient data" : `${performance?.winRate.toFixed(1)}%`}</strong></article>
                <article><span>NET REALIZED P&amp;L</span><strong>{formatPrice(performance?.totalPnlEur ?? 0)}</strong></article>
                <article><span>AVERAGE WIN / LOSS</span><strong>{performance?.averageWinEur === null ? "n/a" : formatPrice(performance?.averageWinEur ?? null)} / {performance?.averageLossEur === null ? "n/a" : formatPrice(performance?.averageLossEur ?? null)}</strong></article>
                <article><span>PROFIT FACTOR</span><strong>{performance?.profitFactor === null ? "n/a" : performance?.profitFactor.toFixed(2)}</strong></article>
                <article><span>MAX REALIZED DRAWDOWN</span><strong>{formatPrice(performance?.maxDrawdownEur ?? 0)}</strong></article>
              </div>}
          {performance?.status === "measured" && (
            <div className="paper-breakdowns">
              {performanceGroups.map(({ label, rows }) => (
                <div className="paper-breakdown" key={label}>
                  <h4>{label}</h4>
                  <table className="paper-breakdown-table">
                    <thead><tr><th>Group</th><th>Trades</th><th>Win rate</th><th>Net P&amp;L</th><th>Profit factor</th></tr></thead>
                    <tbody>{rows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.key}</td><td>{row.tradeCount}</td>
                        <td>{row.winRate === null ? `insufficient data (${row.tradeCount}/5)` : `${row.winRate.toFixed(1)}%`}</td>
                        <td>{formatPrice(row.totalPnlEur)}</td>
                        <td>{row.profitFactor === null ? row.status === "insufficient_data" ? `insufficient data (${row.tradeCount}/5)` : "not defined" : row.profitFactor.toFixed(2)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          <h3 className="paper-subheading">Open virtual positions</h3>
          {portfolio.positions.length === 0
            ? <p className="empty-performance">No open paper positions.</p>
            : <div className="radar-table-wrap"><table className="radar-table">
                <thead><tr><th>Asset / side</th><th>Entry / current</th><th>Size / quantity</th><th>Stop</th><th>Fees</th><th>Unrealized P&amp;L</th><th>Action</th></tr></thead>
                <tbody>{portfolio.positions.map((position) => (
                  <tr key={position.positionId}>
                    <td><strong>{position.asset}</strong><small>{position.side.toUpperCase()} · {position.signalId ? "signal-linked" : "run-linked"}</small></td>
                    <td>{formatPrice(position.entryPriceEur)} / {position.currentPriceEur === null ? position.currentPriceDataStatus : formatPrice(position.currentPriceEur)}<small>{position.currentPriceDataStatus.toUpperCase()}</small></td>
                    <td>{formatPrice(position.notionalEur)} / {position.quantity.toPrecision(6)}</td>
                    <td>{position.stopLossEur === null ? "not set" : formatPrice(position.stopLossEur)}</td>
                    <td>{position.feeRateBps} bps · {formatPrice(position.entryFeeEur + position.exitFeeEur)}</td>
                    <td>{position.unrealizedPnlEur === null ? "missing fresh quote" : formatPrice(position.unrealizedPnlEur)}</td>
                    <td><button className="button-quiet paper-action" disabled={busyId !== null} onClick={() => onClosePosition(position.positionId)}>{busyId === position.positionId ? "Closing…" : "Close demo"}</button></td>
                  </tr>
                ))}</tbody>
              </table></div>}
          <h3 className="paper-subheading">Closed paper-trade history</h3>
          {portfolio.closedTrades.length === 0
            ? <p className="empty-performance">No closed trade results yet.</p>
            : <div className="radar-table-wrap"><table className="radar-table">
                <thead><tr><th>Asset / link</th><th>Opened / closed</th><th>Entry / exit</th><th>Fees</th><th>Realized P&amp;L</th><th>Close reason</th></tr></thead>
                <tbody>{portfolio.closedTrades.map((position) => (
                  <tr key={position.positionId}>
                    <td><strong>{position.asset}</strong><small>{position.signalId ? `signal ${position.signalId.slice(0, 8)}` : `run ${position.runId?.slice(0, 8) ?? "unlinked"}`}</small></td>
                    <td>{formatTimestamp(position.openedAt)}<small>{formatTimestamp(position.closedAt)}</small></td>
                    <td>{formatPrice(position.entryPriceEur)} / {position.exitPriceEur === null ? "missing" : formatPrice(position.exitPriceEur)}</td>
                    <td>{position.feeRateBps} bps · {formatPrice(position.entryFeeEur + position.exitFeeEur)}</td>
                    <td>{position.realizedPnlEur === null ? "insufficient data" : formatPrice(position.realizedPnlEur)}</td>
                    <td>{position.closeReason ?? "unknown"}</td>
                  </tr>
                ))}</tbody>
              </table></div>}
        </>
      )}
      <h3 className="paper-subheading">Immutable radar snapshots and later outcomes</h3>
      {signalError && <p className="inline-error" role="alert">Signal history unavailable: {signalError}</p>}
      {!signalError && signals.length === 0 && <p className="empty-performance">No persisted signal snapshots are available.</p>}
      {signals.length > 0 && <div className="radar-table-wrap"><table className="radar-table">
        <thead><tr><th>Signal / context</th><th>Entry / invalidation</th><th>Quality / data</th><th>1h</th><th>24h</th><th>7d</th><th>Paper entry</th></tr></thead>
        <tbody>{signals.map((signal) => {
          const signalAgeMs = Date.now() - Date.parse(signal.observedAt);
          const eligible = signal.dataStatus === "live" &&
            ["bullish", "bearish"].includes(signal.stance) &&
            signalAgeMs >= 0 &&
            signalAgeMs <= 90 * 60 * 1_000;
          const statusText = (horizon: number) =>
            signal.evaluations.find((result) => result.horizonHours === horizon);
          return (
            <tr key={signal.signalId}>
              <td><strong>{signal.asset} · {signal.stance.toUpperCase()}</strong><small>{formatTimestamp(signal.observedAt)} · {signal.decision}</small><small>{signal.entryIdea}</small></td>
              <td>{signal.entryPriceEur === null ? "missing" : formatPrice(signal.entryPriceEur)}<small>Invalidation: {signal.invalidationPriceEur === null ? "not quantified" : formatPrice(signal.invalidationPriceEur)}</small></td>
              <td>{signal.confidenceScore}/100 quality<small>{signal.dataStatus.toUpperCase()} · momentum {signal.momentumRating === null ? "missing" : signal.momentumRating.toFixed(1)}</small><small>{signal.evidence.length} evidence items · {signal.dataSources.length} sources</small></td>
              {[1, 24, 168].map((horizon) => {
                const evaluation = statusText(horizon);
                return <td key={horizon}>{evaluation?.result.replaceAll("_", " ") ?? "insufficient data"}<small>{evaluation?.returnPercent === null || evaluation?.returnPercent === undefined ? "no measured return" : formatPercent(evaluation.returnPercent)}</small></td>;
              })}
              <td>{eligible
                ? <button className="button-primary paper-action" disabled={!portfolio || busyId !== null || !Number.isFinite(sizeEur) || sizeEur <= 0 || !Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 100} onClick={() => onOpenSignal(signal)}>{busyId === signal.signalId ? "Opening…" : "Open demo"}</button>
                : <span className="paper-ineligible">not actionable</span>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>}
      <p className="performance-caveat">Signal outcome classifications use later completed provider candles only. Missing/freshness gaps remain insufficient data. Paper P&amp;L includes the displayed demo fee assumption; results do not guarantee future performance.</p>
    </section>
  );
}

function App() {
  const [question, setQuestion] = useState("");
  const [asset, setAsset] = useState<AssetCode>("BTC");
  const [agents, setAgents] = useState<AgentCard[]>(idleAgents);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [report, setReport] = useState<ReportView | null>(null);
  const [running, setRunning] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("Overview");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [radar, setRadar] = useState<Awaited<ReturnType<typeof getRadar>> | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [performance, setPerformance] = useState<RadarPerformanceItem[]>([]);
  const [errorSources, setErrorSources] = useState<RadarErrorSource[]>([]);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [signalSnapshots, setSignalSnapshots] = useState<RadarSignalSnapshot[]>([]);
  const [signalHistoryError, setSignalHistoryError] = useState<string | null>(null);
  const [paperPortfolio, setPaperPortfolio] = useState<PaperPortfolio | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperSizeEur, setPaperSizeEur] = useState(250);
  const [feeRateBps, setFeeRateBps] = useState(10);
  const [paperActionId, setPaperActionId] = useState<string | null>(null);
  const [loadingRadar, setLoadingRadar] = useState(true);
  const requestId = useRef(0);
  const pollController = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      setAccountId(getAccountId());
    } catch (error) {
      setRunError(`Paper account ID could not be stored in this browser: ${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller = new AbortController();
      try {
        const result = await getRadar({ signal: controller.signal });
        if (active) {
          setRadar(result);
          setRadarError(null);
        }
      } catch (error) {
        if (active && !controller.signal.aborted) setRadarError(errorMessage(error));
      } finally {
        if (active) setLoadingRadar(false);
      }
      try {
        const result = await getRadarPerformance({ signal: controller.signal });
        if (active) {
          setPerformance(result.performance);
          setErrorSources(result.errorSources);
          setPerformanceError(null);
        }
      } catch (error) {
        if (active && !controller.signal.aborted) setPerformanceError(errorMessage(error));
      }
      try {
        const result = await getRadarSignals({ signal: controller.signal });
        if (active) {
          setSignalSnapshots(result.signals);
          setSignalHistoryError(null);
        }
      } catch (error) {
        if (active && !controller.signal.aborted) setSignalHistoryError(errorMessage(error));
      }
      if (active) timer = setTimeout(() => void refresh(), 60_000);
    };
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller = new AbortController();
      try {
        const result = await getPaperPortfolio(
          { accountId },
          { signal: controller.signal },
        );
        if (active) {
          setPaperPortfolio(result);
          setPaperError(null);
        }
      } catch (error) {
        if (active && !controller.signal.aborted) setPaperError(errorMessage(error));
      }
      if (active) timer = setTimeout(() => void refresh(), 60_000);
    };
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [accountId]);

  useEffect(() => () => {
    requestId.current += 1;
    pollController.current?.abort();
  }, []);

  const resetRun = (clearQuestion = false) => {
    requestId.current += 1;
    pollController.current?.abort();
    pollController.current = null;
    setRunning(false);
    setAgents(idleAgents());
    setActivity([]);
    setReport(null);
    setRunId(null);
    setRunError(null);
    if (clearQuestion) setQuestion("");
  };

  const startAnalysis = async () => {
    if (!question.trim() || running || !accountId) return;
    requestId.current += 1;
    const currentRequest = requestId.current;
    const controller = new AbortController();
    pollController.current?.abort();
    pollController.current = controller;
    setReport(null);
    setActivity([]);
    setAgents(idleAgents().map((agentCard) => ({ ...agentCard, status: "Working" })));
    setRunError(null);
    setRunId(null);
    setRunning(true);
    try {
      const started = await startAnalysisRun({
        accountId,
        asset,
        question: question.trim(),
      }, { signal: controller.signal });
      if (requestId.current !== currentRequest) return;
      setRunId(started.runId);
      addActivity("Master Agent", `Server analysis accepted for ${asset} (${started.runId}).`);
      while (!controller.signal.aborted && requestId.current === currentRequest) {
        const current = await getAnalysisRun(
          { runId: started.runId, accountId },
          { signal: controller.signal },
        );
        if (requestId.current !== currentRequest) return;
        setAgents(mapAgentResults(current.agentResults));
        setActivity(mapActivity(current));
        if (current.finalReport) {
          setReport({ ...current.finalReport, question: current.question });
        }
        if (current.status === "complete") break;
        if (current.status === "error" || current.status === "stopped") {
          if (current.error) setRunError(current.error);
          break;
        }
        await wait(800, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted && requestId.current === currentRequest) {
        setRunError(errorMessage(error));
        setAgents((current) => current.map((agentCard) =>
          agentCard.status === "Working"
            ? { ...agentCard, status: "Error", result: errorMessage(error) }
            : agentCard,
        ));
      }
    } finally {
      if (requestId.current === currentRequest) {
        setRunning(false);
        pollController.current = null;
      }
    }
  };

  const stopAnalysis = async () => {
    if (!running || !runId || !accountId) return;
    try {
      await stopAnalysisRun({ runId, accountId });
      pollController.current?.abort();
      setRunning(false);
      setAgents((current) => current.map((agentCard) =>
        agentCard.status === "Working"
          ? { ...agentCard, status: "Idle", result: "Run stopped by user." }
          : agentCard,
      ));
      addActivity("Master Agent", "Server analysis run stopped.");
    } catch (error) {
      setRunError(`The analysis could not be stopped: ${errorMessage(error)}`);
    }
  };

  const addActivity = (agentName: string, message: string, kind?: "error") => {
    setActivity((entries) => [{
      id: Date.now(),
      agent: agentName,
      message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ...(kind ? { kind } : {}),
    }, ...entries]);
  };

  const refreshSignalHistory = async () => {
    const result = await getRadarSignals();
    setSignalSnapshots(result.signals);
    setSignalHistoryError(null);
  };

  const openSignalPosition = async (signal: RadarSignalSnapshot) => {
    if (!accountId || paperActionId) return;
    setPaperActionId(signal.signalId);
    setPaperError(null);
    try {
      const result = await openPaperTrade({
        accountId,
        signalId: signal.signalId,
        side: signal.stance === "bullish" ? "long" : "short",
        sizeEur: paperSizeEur,
        stopLossEur: signal.invalidationPriceEur,
        takeProfitEur: null,
        feeRateBps,
      });
      setPaperPortfolio(result.portfolio);
      await refreshSignalHistory();
    } catch (error) {
      setPaperError(errorMessage(error));
    } finally {
      setPaperActionId(null);
    }
  };

  const closePaperPosition = async (positionId: string) => {
    if (!accountId || paperActionId) return;
    setPaperActionId(positionId);
    setPaperError(null);
    try {
      const result = await closePaperTrade(positionId, { accountId });
      setPaperPortfolio(result.portfolio);
    } catch (error) {
      setPaperError(errorMessage(error));
    } finally {
      setPaperActionId(null);
    }
  };

  const jumpTo = (section: string) => {
    setActiveNav(section);
    setMobileNavOpen(false);
    document.getElementById(section.toLowerCase().replaceAll(" ", "-"))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const completedCount = agents.filter((agentCard) => agentCard.status === "Complete").length;
  const workingAgentNames = new Set(
    agents.filter((agentCard) => agentCard.status === "Working").map((agentCard) => agentCard.name),
  );
  const statusLabel = running ? "ANALYSIS IN PROGRESS" : report ? "RUN COMPLETE" : "WORKSPACE READY";

  return (
    <div className="desk-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`} data-testid="navigation-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Command size={19} strokeWidth={2.2} /></div>
          <div><div className="brand-name">AMIN <span>AI DESK</span></div><div className="brand-caption">MARKET INTELLIGENCE</div></div>
          <button className="icon-button close-nav" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={17} /></button>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-avatar">A</div><div className="workspace-copy"><span>Personal workspace</span><small>Paper trading only</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className={`nav-item ${activeNav === "Overview" ? "selected" : ""}`} onClick={() => jumpTo("Overview")}><Layers3 size={17} /><span>Overview</span></button>
          <button className={`nav-item ${activeNav === "Radar" ? "selected" : ""}`} onClick={() => jumpTo("Radar")}><Activity size={17} /><span>Market radar</span></button>
          <button className={`nav-item ${activeNav === "Agents" ? "selected" : ""}`} onClick={() => jumpTo("Agents")}><Activity size={17} /><span>Agent network</span><span className="nav-count">14</span></button>
          <button className={`nav-item ${activeNav === "Activity" ? "selected" : ""}`} onClick={() => jumpTo("Activity")}><MessageSquareText size={17} /><span>Agent activity</span>{running && <span className="live-pip" />}</button>
          <button className={`nav-item ${activeNav === "Final Report" ? "selected" : ""}`} onClick={() => jumpTo("Final Report")}><FileText size={17} /><span>Final report</span>{report && <span className="nav-dot" />}</button>
          <button className={`nav-item ${activeNav === "Performance" ? "selected" : ""}`} onClick={() => jumpTo("Performance")}><CheckCheck size={17} /><span>Signal evaluation</span></button>
          <button className={`nav-item ${activeNav === "Paper trading" ? "selected" : ""}`} onClick={() => jumpTo("Paper trading")}><Activity size={17} /><span>Paper trading</span></button>
        </nav>
        <div className="sidebar-rule" />
        <div className="nav-label">SYSTEM</div>
        <div className="local-status"><span className="status-light" /><div><b>PUBLIC MARKET DATA</b><small>No live orders or wallet</small></div></div>
      </aside>
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation overlay" onClick={() => setMobileNavOpen(false)} />}

      <main className="main-column">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button menu-toggle" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>Market intelligence</strong></div></div>
          <div className="topbar-right"><span className="prototype-pill"><span /> PAPER / DEMO</span><span className="topbar-divider" /><span className="topbar-time"><Clock3 size={14} /> {radar ? formatTimestamp(radar.generatedAt) : "Waiting for data"}</span></div>
        </header>

        <div className="content-area">
          <section className="page-heading" id="overview">
            <div className="heading-main"><div className="eyebrow"><span className="eyebrow-line" /> PHASE 5 <span className="eyebrow-sep">/</span> PAPER TRADING &amp; SIGNAL EVALUATION</div><h1>Market analysis<span className="title-period">.</span></h1><p>Source-backed signals, virtual positions, and measured outcomes. No live trading.</p></div>
            <div className="heading-actions">{report && <button className="button-quiet" onClick={() => resetRun()}><RotateCcw size={15} /> New analysis</button>}<div className={`run-state ${running ? "is-running" : report ? "is-complete" : ""}`} data-testid="status-analysis"><span className="run-state-indicator" />{statusLabel}</div></div>
          </section>

          <section className="prompt-panel panel" aria-labelledby="prompt-title">
            <div className="prompt-topline"><div className="section-kicker"><span className="step-index">01</span><span>DEFINE YOUR ANALYSIS</span></div><span className="prompt-meta"><ShieldAlert size={13} /> PAPER TRADING / DEMO ONLY</span></div>
            <label className="sr-only" htmlFor="analysis-asset">Asset</label>
            <select id="analysis-asset" className="asset-select" value={asset} onChange={(event) => setAsset(event.target.value as AssetCode)} disabled={running}>
              {assets.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
            <label className="sr-only" htmlFor="analysis-question">Analysis question</label>
            <textarea id="analysis-question" className="question-input" placeholder="What should the server verify about this asset's current market data?" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={500} data-testid="input-analysis-question" />
            <div className="prompt-footer"><div className="prompt-hint">{question ? <span className="character-count">{question.length} / 500 characters</span> : <span className="prompt-disclaimer">Analysis is based on available public quotes and completed candles only.</span>}</div>{running ? <button className="button-stop" onClick={() => void stopAnalysis()}><Square size={14} fill="currentColor" /> Stop run</button> : <button className="button-primary" disabled={!question.trim() || !accountId} onClick={() => void startAnalysis()}>{report ? <><RotateCcw size={15} /> Run again</> : <>Start analysis <ArrowRight size={15} /></>}</button>}</div>
            {!accountId && <p className="inline-error">A persistent paper account ID is required before starting an analysis.</p>}
            {runError && <p className="inline-error" role="alert">{runError}</p>}
          </section>

          <section className="radar-section" id="radar">
            <div className="section-heading"><div><div className="section-kicker"><span className="step-index">02</span><span>LIVE DATA · SOURCE STATUS</span></div><h2>Master radar</h2></div><span className="agent-count">{loadingRadar ? "Loading" : `${radar?.assets.length ?? 0} assets`}</span></div>
            {radarError && <p className="inline-error" role="alert">Radar unavailable: {radarError}</p>}
            {radar && <p className={`learning-status ${radar.learningStatus}`}>Signal recording: {radar.learningStatus}. Every displayed decision includes source statuses and its analysis timestamp.</p>}
            {radar ? <RadarTable items={radar.assets} /> : <div className="report-empty">{loadingRadar ? "Loading public market data…" : "No market data available. Missing sources are not substituted."}</div>}
          </section>

          <PaperTradingSection
            accountId={accountId}
            portfolio={paperPortfolio}
            portfolioError={paperError}
            signals={signalSnapshots}
            signalError={signalHistoryError}
            sizeEur={paperSizeEur}
            feeRateBps={feeRateBps}
            busyId={paperActionId}
            onSizeChange={setPaperSizeEur}
            onFeeRateChange={setFeeRateBps}
            onOpenSignal={(signal) => void openSignalPosition(signal)}
            onClosePosition={(positionId) => void closePaperPosition(positionId)}
          />

          <div className="dashboard-layout">
            <div className="primary-column">
              <section className="agents-section" id="agents">
                <div className="section-heading"><div><div className="section-kicker"><span className="step-index">03</span><span>SERVER-SIDE AGENT NETWORK</span></div><h2>Specialist agents</h2></div><div className="agent-count" data-testid="text-agent-count"><span>{completedCount.toString().padStart(2, "0")}</span> / 14 complete</div></div>
                <div className="agent-grid" data-testid="agent-grid">
                  {agents.map((agentCard, index) => (
                    <article key={agentCard.id} className={`agent-card ${agentCard.status.toLowerCase()} ${agentCard.id === "master" ? "master-card" : ""}`} data-testid={`card-agent-${agentCard.id}`}>
                      <div className="agent-card-head"><div className={`agent-glyph glyph-${agentCard.id}`}><span>{String(index).padStart(2, "0")}</span></div><span className={`agent-status ${agentCard.status.toLowerCase()}`} data-testid={`status-agent-${agentCard.id}`}><i />{agentCard.status}</span></div>
                      <h3>{agentCard.name}</h3><div className="agent-specialty">{agentCard.specialty}</div>
                      {agentCard.result ? <p className="agent-result" data-testid={`text-agent-result-${agentCard.id}`}>{agentCard.result}</p> : <p className="agent-empty">{running ? "Waiting for server result…" : "Awaiting analysis run"}</p>}
                      {agentCard.dataStatus && <span className={`data-status ${agentCard.dataStatus}`}>{sourceStatusLabel(agentCard.dataStatus)}</span>}
                    </article>
                  ))}
                </div>
                <div className="agent-legend"><span><i className="legend-idle" /> Idle</span><span><i className="legend-working" /> Working</span><span><i className="legend-complete" /> Complete</span><span><i className="legend-error" /> Error</span><small>Unavailable news, macro, social, and on-chain providers remain missing.</small></div>
              </section>

              <section className="report-section" id="final-report">
                <div className="section-heading report-heading"><div><div className="section-kicker"><span className="step-index">04</span><span>VERIFIED MASTER SYNTHESIS</span></div><h2>Final report</h2></div>{report && <span className="report-complete"><CheckCheck size={14} /> SERVER REPORT</span>}</div>
                {report ? (
                  <article className="report-card" data-testid="content-final-report">
                    <div className="report-banner"><div className="report-icon"><FileText size={17} /></div><div><span>{report.currentData.asset} · {report.dataStatus.toUpperCase()} · {formatTimestamp(report.generatedAt)}</span><h3>{signalStateLabel(report.radarState)}</h3></div></div>
                    <div className="report-question"><span>QUESTION CONTEXT</span><p data-testid="text-report-question">{report.question}</p></div>
                    <section className="report-summary-block" data-testid="text-report-summary"><h4>STANCE · {report.stance.toUpperCase()}</h4><p>{report.summary}</p></section>
                    <section className="report-detail report-market"><h4><Activity size={15} /> CURRENT DATA</h4><p>{report.currentData.asset}: {formatPrice(report.currentData.priceEur)} · 24h {formatPercent(report.currentData.change24hPercent)} · Volume {report.currentData.volume24hEur === null ? "missing" : formatPrice(report.currentData.volume24hEur)}</p><ul>{report.currentData.sourceStatuses.map((source) => <li key={`${source.source}:${source.checkedAt}`}>{source.source}: {sourceStatusLabel(source.status)} · observed {formatTimestamp(source.observedAt)} · {source.detail}</li>)}</ul></section>
                    <div className="report-insight-grid">
                      <section className="report-detail report-bullish"><h4><ArrowUpRight size={15} /> MAIN REASONS</h4><ul>{report.mainReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
                      <section className="report-detail report-bearish"><h4><ArrowDownRight size={15} /> COUNTER-ARGUMENTS</h4><ul>{report.counterArguments.map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
                    </div>
                    <section className="report-detail"><h4><CheckCheck size={15} /> RAW-DATA EVIDENCE</h4><ul>{report.evidence.map((item, index) => <li key={`${item.metric}:${item.source}:${index}`}>{item.metric}: {item.value} · {item.source} · {formatTimestamp(item.timestamp)} · {sourceStatusLabel(item.dataStatus)}</li>)}</ul></section>
                    <section className="report-detail report-verification"><h4><ShieldAlert size={15} /> INVALIDATION</h4><p>{report.invalidation}</p></section>
                    <section className="report-confidence" data-testid="content-confidence-score"><div className="confidence-copy"><span>DATA QUALITY INDEX · NOT A WIN PROBABILITY</span><strong>{report.confidenceScore}<small> / 100</small></strong><b>{report.confidenceLabel}</b></div><div className="confidence-track" role="progressbar" aria-label="Data quality index" aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.confidenceScore}><span style={{ width: `${report.confidenceScore}%` }} /></div><p>{report.confidenceBreakdown.methodology}</p><p>Coverage {report.confidenceBreakdown.coverageScore} · Freshness {report.confidenceBreakdown.freshnessScore} · Agreement {report.confidenceBreakdown.agreementScore} · Verification {report.confidenceBreakdown.verificationScore} · Confirmations {report.confidenceBreakdown.confirmationCount} · Contradictions {report.confidenceBreakdown.contradictionCount}</p></section>
                    <section className="report-detail"><h4>TECHNICAL SCORE FACTORS</h4><ul>{report.scoreFactors.map((factor) => <li key={factor.name}>{factor.name}: {factor.value === null ? "missing" : factor.value.toFixed(1)} · {sourceStatusLabel(factor.dataStatus)} · {factor.explanation}</li>)}</ul></section>
                    <div className="report-caveat"><ShieldAlert size={15} /><p>Paper trading / demo only. No real orders, wallets, or money are connected. This analysis is not financial advice and does not guarantee outcomes.</p></div>
                  </article>
                ) : <div className={`report-empty ${running ? "report-pending" : ""}`} data-testid="empty-final-report"><div className="empty-report-icon">{running ? <Activity size={19} /> : <FileText size={19} />}</div><div className="empty-report-copy"><h3>{running ? "Server analysis is running" : "No analysis yet"}</h3><p>{running ? `Waiting for evidence-backed results for ${asset}.` : "Start an analysis to fetch public quotes and completed candles. Missing or stale data will remain explicitly marked."}</p></div><span className="empty-report-state">{running ? "IN PROGRESS" : "NO REPORT"}</span></div>}
              </section>

              <section className="performance-section" id="performance">
                <div className="section-heading"><div><div className="section-kicker"><span className="step-index">05</span><span>MEASURED OUTCOMES</span></div><h2>Signal evaluation</h2></div></div>
                {performanceError && <p className="inline-error" role="alert">Evaluation history unavailable: {performanceError}</p>}
                <PerformanceTable items={performance} errorSources={errorSources} />
              </section>
            </div>

            <aside className="activity-column" id="activity">
              <div className="activity-sticky"><div className="activity-header"><div><div className="section-kicker"><span className="step-index">06</span><span>SERVER TRACE</span></div><h2>Agent activity</h2></div>{running ? <span className="activity-live"><i /> RUNNING</span> : <span className="activity-local">SESSION</span>}</div>
                <div className="activity-panel panel" data-testid="activity-feed">{activity.length === 0 ? <div className="activity-empty"><div className="activity-empty-mark"><Activity size={17} /></div><strong>Waiting for server events</strong><p>Agent activity is read from the persisted analysis run.</p></div> : <><div className="feed-label"><span>RUN TIMELINE</span><span>{activity.length.toString().padStart(2, "0")} EVENTS</span></div><ol className="activity-list">{activity.map((entry) => <li className={`activity-entry ${running && workingAgentNames.has(entry.agent) ? "activity-current" : ""}`} key={`${entry.id}:${entry.agent}`}><span className={`timeline-dot ${entry.kind === "error" ? "timeline-dot-error" : ""}`}>{entry.kind === "error" ? <AlertTriangle size={11} /> : <Check size={11} />}</span><div className="activity-entry-content"><div className="activity-entry-top"><b>{entry.agent}</b><time>{entry.time}</time></div><p>{entry.message}</p></div></li>)}</ol><div className="activity-foot">{running ? <><span className="activity-pulse" /> Sequence running</> : <><Check size={12} /> Stored run event log</>}</div></>}</div>
                <div className="activity-note"><ShieldAlert size={14} /><span>Public market data only. No live orders, wallet access, or real-money trading.</span></div>
              </div>
            </aside>
          </div>

          <footer className="page-footer" id="disclaimer"><div className="footer-brand"><div className="footer-mark"><Command size={13} /></div><span>AMIN AI DESK</span><i /> PAPER / DEMO</div><p>Data quality and historical outcomes are descriptive only. No guaranteed hit rate; unsupported feeds are not simulated.</p><button onClick={() => jumpTo("Overview")}>BACK TO TOP <ArrowUpRight size={13} /></button></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
