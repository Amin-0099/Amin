import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  FileText,
  Layers3,
  Menu,
  MessageSquareText,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { analyzeMarketScanner } from '@workspace/api-client-react';
import {
  type Agent,
  type FinalReport,
  createFinalReport,
  createRiskAssessment,
  createSpecialistResult,
  createVerificationReview,
  agentBlueprints,
  createIdleAgents,
  firstWaveAgentIds,
  simulatedFirstWaveAgentIds,
  getMarketScenario,
} from './simulation';
import './index.css';

type ActivityEntry = { id: number; agent: string; message: string; time: string; kind?: 'error' };

const defaultQuestion = '';

function getMarketScannerError(error: unknown): string {
  if (error && typeof error === 'object') {
    const responseData = 'data' in error ? error.data : undefined;
    if (
      responseData &&
      typeof responseData === 'object' &&
      'error' in responseData &&
      typeof responseData.error === 'string'
    ) {
      return responseData.error;
    }

    const status = 'status' in error ? error.status : undefined;
    if (status === 429) {
      return 'Gemini quota or rate limit reached. No Market Scanner analysis was generated. Check the Gemini API quota and try again later.';
    }
    if (status === 503) {
      return 'Gemini is not configured or cannot access the API. Check the server configuration and try again.';
    }
    if (status === 504) {
      return 'Gemini took too long to respond. No Market Scanner analysis was generated; try again.';
    }
  }

  return 'Gemini request failed. No Market Scanner analysis was generated. Check the server connection and try again.';
}

function App() {
  const [question, setQuestion] = useState(defaultQuestion);
  const [agents, setAgents] = useState<Agent[]>(createIdleAgents);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [report, setReport] = useState<FinalReport | null>(null);
  const [running, setRunning] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeNav, setActiveNav] = useState('Overview');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerResolverRef = useRef<(() => void) | null>(null);
  const marketAbortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const activityId = useRef(0);

  const clearPendingTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const resolve = timerResolverRef.current;
    timerResolverRef.current = null;
    resolve?.();
  };

  const waitForStage = (duration: number) => new Promise<void>((resolve) => {
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      timerResolverRef.current = null;
      resolve();
    }, duration);
    timerResolverRef.current = resolve;
  });

  useEffect(() => () => {
    runRef.current += 1;
    clearPendingTimer();
    marketAbortRef.current?.abort();
  }, []);

  const addActivity = (agent: string, message: string, kind?: 'error') => {
    activityId.current += 1;
    const now = new Date();
    setActivity((entries) => [
      {
        id: activityId.current,
        agent,
        message,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        kind,
      },
      ...entries,
    ]);
  };

  const resetRun = (clearQuestion = false) => {
    runRef.current += 1;
    clearPendingTimer();
    marketAbortRef.current?.abort();
    marketAbortRef.current = null;
    setRunning(false);
    setAgents(createIdleAgents());
    setActivity([]);
    setReport(null);
    if (clearQuestion) setQuestion('');
  };

  const startAnalysis = async () => {
    if (!question.trim() || running) return;
    clearPendingTimer();
    marketAbortRef.current?.abort();
    const currentRun = ++runRef.current;
    const context = question.trim();
    const scenario = getMarketScenario(context);
    const findings: Partial<Record<(typeof firstWaveAgentIds)[number], ReturnType<typeof createSpecialistResult>>> = {};
    const controller = new AbortController();
    marketAbortRef.current = controller;

    setReport(null);
    setActivity([]);
    setAgents(createIdleAgents().map((agent) => {
      if (agent.id === 'master') {
        return { ...agent, status: 'Working', result: `Request received: ${context}` };
      }
      if ((firstWaveAgentIds as readonly string[]).includes(agent.id)) {
        return { ...agent, status: 'Working' };
      }
      return agent;
    }));
    setRunning(true);
    addActivity('Master Agent', `Request received: “${context}”`);
    addActivity('Master Agent', 'Dispatching to the Gemini-powered Market Scanner and five simulated specialists.');

    firstWaveAgentIds.forEach((id) => {
      const definition = agentBlueprints.find((agent) => agent.id === id);
      if (definition) {
        addActivity(
          definition.name,
          id === 'market' ? 'Question sent to Gemini for AI analysis.' : 'Started simulated review.',
        );
      }
    });

    const marketRequest = analyzeMarketScanner(
      { question: context },
      { signal: controller.signal },
    ).then(({ analysis }) => {
      if (runRef.current !== currentRun) return null;

      const finding = {
        summary: analysis,
        stance: 'neutral' as const,
        evidenceNote: 'Gemini analysis is based on the question only; no live market feed or source evidence was retrieved.',
      };
      findings.market = finding;
      setAgents((current) => current.map((agent) => (
        agent.id === 'market'
          ? { ...agent, status: 'Complete', result: analysis, aiLive: true }
          : agent
      )));
      addActivity(
        'Market Scanner',
        'Gemini returned an AI analysis. No live market-data feed was used.',
      );
      return finding;
    }).catch((error: unknown) => {
      if (runRef.current !== currentRun) return null;

      const message = getMarketScannerError(error);
      setAgents((current) => current.map((agent) => (
        agent.id === 'market'
          ? { ...agent, status: 'Error', result: message, aiLive: false }
          : agent
      )));
      addActivity('Market Scanner', message, 'error');
      return null;
    });

    await waitForStage(1300);
    if (runRef.current !== currentRun) return;

    simulatedFirstWaveAgentIds.forEach((id) => {
      findings[id] = createSpecialistResult(id, scenario);
    });
    setAgents((current) => current.map((agent) => (
      simulatedFirstWaveAgentIds.includes(agent.id as (typeof simulatedFirstWaveAgentIds)[number])
        ? {
            ...agent,
            status: 'Complete',
            result: findings[agent.id as (typeof simulatedFirstWaveAgentIds)[number]]?.summary ?? '',
          }
        : agent
    )));
    simulatedFirstWaveAgentIds.forEach((id) => {
      const definition = agentBlueprints.find((agent) => agent.id === id);
      if (definition) addActivity(definition.name, `Complete — ${findings[id]?.summary}`);
    });

    await marketRequest;
    if (runRef.current !== currentRun) return;

    const riskAgent = agentBlueprints.find((agent) => agent.id === 'risk');
    setAgents((current) => current.map((agent) => (
      agent.id === 'risk' ? { ...agent, status: 'Working', result: '' } : agent
    )));
    if (riskAgent) addActivity(riskAgent.name, 'Started a separate simulated downside and evidence-risk assessment.');

    await waitForStage(850);
    if (runRef.current !== currentRun) return;

    const riskAssessment = createRiskAssessment(scenario);
    setAgents((current) => current.map((agent) => (
      agent.id === 'risk'
        ? { ...agent, status: 'Complete', result: riskAssessment.assessment }
        : agent
    )));
    if (riskAgent) addActivity(riskAgent.name, `Complete — ${riskAssessment.assessment}`);

    const verifier = agentBlueprints.find((agent) => agent.id === 'verification');
    setAgents((current) => current.map((agent) => (
      agent.id === 'verification' ? { ...agent, status: 'Working', result: '' } : agent
    )));
    if (verifier) {
      addActivity(
        verifier.name,
        'Reviewing available specialist findings and the Risk Analyst assessment for conflicts and weak evidence.',
      );
    }

    await waitForStage(900);
    if (runRef.current !== currentRun) return;

    const verification = createVerificationReview(findings, riskAssessment);
    setAgents((current) => current.map((agent) => (
      agent.id === 'verification'
        ? { ...agent, status: 'Complete', result: verification.summary }
        : agent
    )));
    if (verifier) {
      addActivity(
        verifier.name,
        `Complete — ${verification.summary} ${verification.contradictions[0]}`,
      );
    }

    const decisionAgent = agentBlueprints.find((agent) => agent.id === 'decision');
    setAgents((current) => current.map((agent) => (
      agent.id === 'decision' ? { ...agent, status: 'Working', result: '' } : agent
    )));
    if (decisionAgent) {
      addActivity(
        decisionAgent.name,
        'Started final synthesis using verified findings and the separate Risk Analyst assessment.',
      );
    }

    await waitForStage(900);
    if (runRef.current !== currentRun) return;

    const nextReport = createFinalReport(
      context,
      scenario,
      riskAssessment,
      verification,
      findings.market?.summary ?? null,
    );
    setAgents((current) => current.map((agent) => {
      if (agent.id === 'decision') {
        return { ...agent, status: 'Complete', result: nextReport.conclusion };
      }
      if (agent.id === 'master') {
        return {
          ...agent,
          status: 'Complete',
          result: 'Coordination complete. The report combines the Gemini Market Scanner result when available, simulated specialist findings, verification, and risk assessment.',
        };
      }
      return agent;
    }));
    setReport(nextReport);
    setRunning(false);
    if (marketAbortRef.current === controller) marketAbortRef.current = null;
    if (decisionAgent) addActivity(decisionAgent.name, `Complete — ${nextReport.conclusion}`);
    addActivity('Master Agent', 'Final report is complete and ready for review.');
  };

  const stopAnalysis = () => {
    if (!running) return;
    runRef.current += 1;
    clearPendingTimer();
    marketAbortRef.current?.abort();
    marketAbortRef.current = null;
    setRunning(false);
    setAgents((current) => current.map((agent) => (
      agent.status === 'Working' ? { ...agent, status: 'Idle', result: '' } : agent
    )));
    addActivity('Master Agent', 'Run stopped. Completed sample findings are retained; unfinished agents returned to idle.');
  };

  const jumpTo = (section: string) => {
    setActiveNav(section);
    setMobileNavOpen(false);
    const target = document.getElementById(section.toLowerCase().replaceAll(' ', '-'));
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const setExample = () => {
    setQuestion('What market conditions would confirm a sustained move in the current cycle?');
  };

  const completedCount = agents.filter((agent) => agent.status === 'Complete').length;
  const workingAgentNames = new Set(
    agents.filter((agent) => agent.status === 'Working').map((agent) => agent.name),
  );
  const statusLabel = running ? 'ANALYSIS IN PROGRESS' : report ? 'RUN COMPLETE' : 'WORKSPACE READY';

  return (
    <div className="desk-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`} data-testid="navigation-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Command size={19} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">AMIN <span>AI DESK</span></div>
            <div className="brand-caption">MULTI-AGENT ANALYSIS</div>
          </div>
          <button className="icon-button close-nav" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} data-testid="button-close-navigation">
            <X size={17} />
          </button>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">A</div>
          <div className="workspace-copy"><span>Personal workspace</span><small>Local prototype</small></div>
          <ChevronDown size={15} className="muted-icon" />
        </div>

        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className={`nav-item ${activeNav === 'Overview' ? 'selected' : ''}`} onClick={() => jumpTo('Overview')} data-testid="nav-overview">
            <Layers3 size={17} /><span>Overview</span><span className="nav-shortcut">01</span>
          </button>
          <button className={`nav-item ${activeNav === 'Agents' ? 'selected' : ''}`} onClick={() => jumpTo('Agents')} data-testid="nav-agents">
            <Activity size={17} /><span>Agent network</span><span className="nav-count">10</span>
          </button>
          <button className={`nav-item ${activeNav === 'Activity' ? 'selected' : ''}`} onClick={() => jumpTo('Activity')} data-testid="nav-activity">
            <MessageSquareText size={17} /><span>Agent activity</span>
            {running && <span className="live-pip" />}
          </button>
          <button className={`nav-item ${activeNav === 'Final Report' ? 'selected' : ''}`} onClick={() => jumpTo('Final Report')} data-testid="nav-report">
            <FileText size={17} /><span>Final report</span>
            {report && <span className="nav-dot" />}
          </button>
        </nav>

        <div className="sidebar-rule" />
        <div className="nav-label">SYSTEM</div>
        <button className="nav-item help-link" onClick={() => document.getElementById('disclaimer')?.scrollIntoView({ behavior: 'smooth' })} data-testid="nav-prototype-notes">
          <CircleHelp size={17} /><span>Prototype notes</span>
        </button>

        <div className="sidebar-bottom">
          <div className="local-status"><span className="status-light" /><div><b>GEMINI + SIMULATION</b><small>Only Market Scanner calls Gemini</small></div></div>
          <div className="profile-row">
            <div className="profile-initials">AD</div>
            <div className="profile-name"><b>Analyst desk</b><small>Demo workspace</small></div>
            <span className="profile-more">•••</span>
          </div>
        </div>
      </aside>
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation overlay" onClick={() => setMobileNavOpen(false)} data-testid="button-navigation-overlay" />}

      <main className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-toggle" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)} data-testid="button-open-navigation"><Menu size={19} /></button>
            <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>Analysis desk</strong></div>
          </div>
          <div className="topbar-right">
            <span className="prototype-pill"><span /> PROTOTYPE</span>
            <span className="topbar-divider" />
            <span className="topbar-time"><Clock3 size={14} /> Local run</span>
            <div className="top-avatar">AD</div>
          </div>
        </header>

        <div className="content-area">
          <section className="page-heading" id="overview">
            <div className="heading-main">
              <div className="eyebrow"><span className="eyebrow-line" /> ANALYSIS WORKSPACE <span className="eyebrow-sep">/</span> 01</div>
              <h1>Market analysis<span className="title-period">.</span></h1>
              <p>One question. Ten specialist perspectives. A clear, transparent synthesis.</p>
            </div>
            <div className="heading-actions">
              {report && <button className="button-quiet" onClick={() => resetRun()} data-testid="button-reset-analysis"><RotateCcw size={15} /> New analysis</button>}
              <div className={`run-state ${running ? 'is-running' : report ? 'is-complete' : ''}`} data-testid="status-analysis">
                <span className="run-state-indicator" />{statusLabel}
              </div>
            </div>
          </section>

          <section className="prompt-panel panel" aria-labelledby="prompt-title">
            <div className="prompt-topline">
              <div className="section-kicker"><span className="step-index">01</span><span>DEFINE YOUR QUESTION</span></div>
              <span className="prompt-meta"><ShieldAlert size={13} /> SIMULATED ANALYSIS ONLY</span>
            </div>
            <label className="sr-only" htmlFor="analysis-question">Market question</label>
            <textarea
              id="analysis-question"
              className="question-input"
              placeholder="What would you like the agent network to analyze?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={500}
              data-testid="input-analysis-question"
            />
            <div className="prompt-footer">
              <div className="prompt-hint">
                {!question && !running && <button className="example-question" onClick={setExample} data-testid="button-use-example"><Sparkles size={13} /> Try a sample question <ArrowRight size={13} /></button>}
                {question && <span className="character-count" data-testid="text-question-count">{question.length} / 500 characters</span>}
                {!question && <span className="prompt-disclaimer">Keep your question focused for a sharper synthesis.</span>}
              </div>
              {running ? (
                <button className="button-stop" onClick={stopAnalysis} data-testid="button-stop-analysis"><Square size={14} fill="currentColor" /> Stop run</button>
              ) : (
                <button className="button-primary" disabled={!question.trim()} onClick={startAnalysis} data-testid="button-start-analysis">
                  {report ? <><RotateCcw size={15} /> Run again</> : <><span className="button-spark"><Sparkles size={14} /></span> Start analysis <ArrowRight size={15} /></>}
                </button>
              )}
            </div>
          </section>

          <div className="dashboard-layout">
            <div className="primary-column">
              <section className="agents-section" id="agents">
                <div className="section-heading">
                  <div><div className="section-kicker"><span className="step-index">02</span><span>AGENT NETWORK</span></div><h2>Specialist agents</h2></div>
                  <div className="agent-count" data-testid="text-agent-count"><span>{completedCount.toString().padStart(2, '0')}</span> / 10 complete</div>
                </div>
                <div className="agent-grid" data-testid="agent-grid">
                  {agents.map((agent, index) => (
                    <article key={agent.id} className={`agent-card ${agent.status.toLowerCase()} ${agent.aiLive ? 'agent-card-live' : ''} ${agent.id === 'master' ? 'master-card' : ''}`} data-testid={`card-agent-${agent.id}`}>
                      <div className="agent-card-head">
                        <div className={`agent-glyph glyph-${agent.id}`}>{agent.id === 'master' ? <Command size={16} /> : <span>{String(index).padStart(2, '0')}</span>}</div>
                        <span className={`agent-status ${agent.status.toLowerCase()}`} data-testid={`status-agent-${agent.id}`}>
                          <i />{agent.status}
                          {agent.aiLive && <b className="agent-live-badge"><Sparkles size={9} /> AI LIVE</b>}
                        </span>
                      </div>
                      <h3>{agent.name}</h3>
                      <div className="agent-specialty">{agent.specialty}</div>
                      {agent.result ? (
                        <p className="agent-result" data-testid={`text-agent-result-${agent.id}`}>{agent.result}</p>
                      ) : (
                        <p className="agent-empty">{agent.status === 'Working' ? 'Evaluating assigned perspective…' : 'Awaiting analysis run'}</p>
                      )}
                      {agent.id === 'master' && <div className="master-tag"><span /> COORDINATOR</div>}
                    </article>
                  ))}
                </div>
                <div className="agent-legend"><span><i className="legend-idle" /> Idle</span><span><i className="legend-working" /> Working</span><span><i className="legend-complete" /> Complete</span><span><i className="legend-error" /> Error</span><small>Market Scanner uses Gemini; the other agents are simulated.</small></div>
              </section>

              <section className="report-section" id="final-report">
                <div className="section-heading report-heading">
                  <div><div className="section-kicker"><span className="step-index">04</span><span>MASTER AGENT SYNTHESIS</span></div><h2>Final report</h2></div>
                  {report && <span className="report-complete"><CheckCheck size={14} /> SYNTHESIS COMPLETE</span>}
                </div>
                {report ? (
                  <article className="report-card" data-testid="content-final-report">
                    <div className="report-banner">
                      <div className="report-icon"><FileText size={17} /></div>
                      <div><span>SIMULATED REPORT <span className="report-divider">·</span> MASTER AGENT</span><h3>{report.headline}</h3></div>
                      <div className="report-index">AM / 01</div>
                    </div>
                    <div className="report-question"><span>QUESTION CONTEXT</span><p data-testid="text-report-question">{report.question}</p></div>
                    <section className="report-summary-block" data-testid="text-report-summary">
                      <h4>SUMMARY</h4>
                      <p>{report.summary}</p>
                    </section>
                    <section className={`report-detail report-market ${report.marketScannerAnalysis ? 'report-market-live' : 'report-market-unavailable'}`} data-testid="content-market-scanner-report">
                      <h4><Sparkles size={15} /> MARKET SCANNER · {report.marketScannerAnalysis ? 'GEMINI AI LIVE' : 'UNAVAILABLE'}</h4>
                      <p>{report.marketScannerAnalysis ?? 'Gemini returned no analysis for this run. No simulated Market Scanner result was substituted.'}</p>
                    </section>
                    <div className="report-insight-grid">
                      <section className="report-detail report-bullish" data-testid="list-bullish-signals">
                        <h4><ArrowUpRight size={15} /> BULLISH SIGNALS</h4>
                        <ul>{report.bullishSignals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
                      </section>
                      <section className="report-detail report-bearish" data-testid="list-bearish-signals">
                        <h4><ArrowDownRight size={15} /> BEARISH SIGNALS</h4>
                        <ul>{report.bearishSignals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
                      </section>
                    </div>
                    <section className="report-detail report-risk" data-testid="content-risk-assessment">
                      <h4><ShieldAlert size={15} /> RISK ANALYST ASSESSMENT</h4>
                      <p>{report.riskAssessment}</p>
                      <ul>{report.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
                    </section>
                    <section className="report-detail report-verification" data-testid="content-verification-review">
                      <h4><CheckCheck size={15} /> VERIFICATION REVIEW</h4>
                      <p>{report.verification.summary}</p>
                      <strong>Contradictions and gaps</strong>
                      <ul>
                        {[...report.verification.contradictions, ...report.verification.weakEvidence].map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                    <section className="report-confidence" data-testid="content-confidence-score">
                      <div className="confidence-copy">
                        <span>CONFIDENCE SCORE</span>
                        <strong>{report.confidenceScore}<small> / 100</small></strong>
                        <b>{report.confidenceLabel}</b>
                      </div>
                      <div
                        className="confidence-track"
                        role="progressbar"
                        aria-label="Simulated confidence score"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={report.confidenceScore}
                      >
                        <span style={{ width: `${report.confidenceScore}%` }} />
                      </div>
                      <p>This score reflects only internal consistency of the mock profile, not confidence in a real market outcome.</p>
                    </section>
                    <section className="report-conclusion" data-testid="text-final-conclusion">
                      <span>FINAL SIMULATED CONCLUSION</span>
                      <p>{report.conclusion}</p>
                    </section>
                    <div className="report-caveat" data-testid="text-report-disclaimer"><ShieldAlert size={15} /><p>{report.caveat}</p></div>
                    <div className="report-foot"><span>{report.marketScannerAnalysis ? 'Gemini Market Scanner + simulated agents' : 'Simulated agents · Market Scanner unavailable'}</span><span>Context retained from your question</span></div>
                  </article>
                ) : (
                  <div className={`report-empty ${running ? 'report-pending' : ''}`} data-testid="empty-final-report">
                    <div className="empty-report-icon">{running ? <Activity size={19} /> : <FileText size={19} />}</div>
                    <div className="empty-report-copy">
                      <h3>{running ? 'Synthesis follows agent review' : 'Your synthesis will appear here'}</h3>
                      <p>{running ? 'The Master Agent is coordinating the Gemini Market Scanner response and simulated specialist findings. The report appears after review.' : 'Submit a question to begin. The Master Agent will combine the Market Scanner response when available with the other simulated perspectives.'}</p>
                    </div>
                    <span className="empty-report-state">{running ? 'IN PROGRESS' : 'NO REPORT YET'}</span>
                  </div>
                )}
              </section>
            </div>

            <aside className="activity-column" id="activity">
              <div className="activity-sticky">
                <div className="activity-header">
                  <div><div className="section-kicker"><span className="step-index">03</span><span>LIVE TRACE</span></div><h2>Agent activity</h2></div>
                  {running ? <span className="activity-live"><i /> RUNNING</span> : <span className="activity-local">SESSION</span>}
                </div>
                <div className="activity-panel panel" data-testid="activity-feed">
                  {activity.length === 0 ? (
                    <div className="activity-empty" data-testid="empty-activity">
                      <div className="activity-empty-mark"><Activity size={17} /></div>
                      <strong>Quiet on the network</strong>
                      <p>When you start an analysis, the Market Scanner's Gemini request and each agent's progress will appear here.</p>
                      <div className="empty-feed-line"><span /> WAITING FOR INPUT</div>
                    </div>
                  ) : (
                    <>
                      <div className="feed-label"><span>RUN TIMELINE</span><span>{activity.length.toString().padStart(2, '0')} EVENTS</span></div>
                      <ol className="activity-list">
                        {activity.map((entry) => {
                          const isWorking = running && workingAgentNames.has(entry.agent);
                          return (
                          <li className={`activity-entry ${isWorking ? 'activity-current' : ''}`} key={entry.id} data-testid={`activity-entry-${entry.id}`}>
                            <span className={`timeline-dot ${entry.kind === 'error' ? 'timeline-dot-error' : ''}`}>{entry.kind === 'error' ? <AlertTriangle size={11} /> : isWorking ? <i /> : <Check size={11} />}</span>
                            <div className="activity-entry-content">
                              <div className="activity-entry-top"><b>{entry.agent}</b><time>{entry.time}</time></div>
                              <p>{entry.message}</p>
                            </div>
                          </li>
                          );
                        })}
                      </ol>
                      <div className="activity-foot">{running ? <><span className="activity-pulse" /> Sequence running</> : <><Check size={12} /> Session event log</>}</div>
                    </>
                  )}
                </div>
                <div className="activity-note"><ShieldAlert size={14} /><span>Only Market Scanner uses Gemini. No live market feeds, exchanges, wallets, or trading connections.</span></div>
              </div>
            </aside>
          </div>

          <footer className="page-footer" id="disclaimer">
            <div className="footer-brand"><div className="footer-mark"><Command size={13} /></div><span>AMIN AI DESK</span><i /> ANALYSIS PROTOTYPE</div>
            <p>Gemini powers only the Market Scanner; no live market data is connected. Other agent outputs are simulated, not investment advice.</p>
            <button onClick={() => jumpTo('Overview')} data-testid="button-back-to-top">BACK TO TOP <ArrowUpRight size={13} /></button>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
