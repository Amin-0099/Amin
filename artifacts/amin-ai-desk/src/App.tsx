import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
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
import {
  type Agent,
  agentBlueprints,
  createIdleAgents,
  createSampleReport,
  sampleResults,
  stagedAgentIds,
} from './simulation';
import './index.css';

type ActivityEntry = { id: number; agent: string; message: string; time: string };
type Report = ReturnType<typeof createSampleReport>;

const defaultQuestion = '';

function App() {
  const [question, setQuestion] = useState(defaultQuestion);
  const [agents, setAgents] = useState<Agent[]>(createIdleAgents);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeNav, setActiveNav] = useState('Overview');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef(0);
  const activityId = useRef(0);

  useEffect(() => () => {
    runRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const addActivity = (agent: string, message: string) => {
    activityId.current += 1;
    const now = new Date();
    setActivity((entries) => [
      {
        id: activityId.current,
        agent,
        message,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      ...entries,
    ]);
  };

  const resetRun = (clearQuestion = false) => {
    runRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    setRunning(false);
    setAgents(createIdleAgents());
    setActivity([]);
    setReport(null);
    if (clearQuestion) setQuestion('');
  };

  const startAnalysis = () => {
    if (!question.trim() || running) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const currentRun = ++runRef.current;
    const context = question.trim();
    setReport(null);
    setActivity([]);
    setAgents(createIdleAgents().map((agent) => (
      agent.id === 'master' ? { ...agent, status: 'Working' } : agent
    )));
    setRunning(true);
    addActivity('Master Agent', 'Analysis started. Delegating the question across nine specialist lenses.');

    const runStep = (stepIndex: number) => {
      if (runRef.current !== currentRun) return;
      if (stepIndex >= stagedAgentIds.length) {
        setAgents((current) => current.map((agent) => (
          agent.id === 'master'
            ? {
                ...agent,
                status: 'Finished',
                result: 'Synthesis complete. Findings reconciled into a transparent, simulated report.',
              }
            : agent
        )));
        const nextReport = createSampleReport(context);
        setReport(nextReport);
        setRunning(false);
        addActivity('Master Agent', 'Synthesis complete. A simulated report is ready for review.');
        return;
      }
      const id = stagedAgentIds[stepIndex];
      const definition = agentBlueprints.find((agent) => agent.id === id);
      if (!definition) return;
      setAgents((current) => current.map((agent) => (
        agent.id === id ? { ...agent, status: 'Working' } : agent
      )));
      addActivity(definition.name, `Reviewing the question through ${definition.specialty.toLowerCase()}.`);
      timerRef.current = setTimeout(() => {
        if (runRef.current !== currentRun) return;
        const result = sampleResults[id] ?? 'Sample review complete.';
        setAgents((current) => current.map((agent) => (
          agent.id === id ? { ...agent, status: 'Finished', result } : agent
        )));
        addActivity(definition.name, result);
        timerRef.current = setTimeout(() => runStep(stepIndex + 1), 480);
      }, 820);
    };

    timerRef.current = setTimeout(() => runStep(0), 450);
  };

  const stopAnalysis = () => {
    if (!running) return;
    runRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    setRunning(false);
    setAgents((current) => current.map((agent) => (
      agent.status === 'Working' ? { ...agent, status: 'Idle' } : agent
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

  const completedCount = agents.filter((agent) => agent.status === 'Finished').length;
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
          <div className="local-status"><span className="status-light" /><div><b>LOCAL SIMULATION</b><small>No external data sources</small></div></div>
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
                    <article key={agent.id} className={`agent-card ${agent.status.toLowerCase()} ${agent.id === 'master' ? 'master-card' : ''}`} data-testid={`card-agent-${agent.id}`}>
                      <div className="agent-card-head">
                        <div className={`agent-glyph glyph-${agent.id}`}>{agent.id === 'master' ? <Command size={16} /> : <span>{String(index).padStart(2, '0')}</span>}</div>
                        <span className={`agent-status ${agent.status.toLowerCase()}`} data-testid={`status-agent-${agent.id}`}>
                          <i />{agent.status}
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
                <div className="agent-legend"><span><i className="legend-idle" /> Idle</span><span><i className="legend-working" /> Working</span><span><i className="legend-finished" /> Finished</span><small>All findings in this prototype are generated locally.</small></div>
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
                    <p className="report-summary" data-testid="text-report-summary">{report.summary}</p>
                    <div className="signal-grid">
                      {report.signals.map((signal) => (
                        <div className={`signal-item signal-${signal.tone}`} key={signal.label} data-testid={`signal-${signal.label.toLowerCase().replaceAll(' ', '-')}`}>
                          <span>{signal.label}</span><b>{signal.value}</b>
                          <i>{signal.tone === 'teal' ? <ArrowUpRight size={15} /> : signal.tone === 'amber' ? <ArrowDownRight size={15} /> : <Activity size={15} />}</i>
                        </div>
                      ))}
                    </div>
                    <div className="watch-block"><div className="watch-title"><span className="watch-mark" /> WHAT TO WATCH</div><p>{report.watch}</p></div>
                    <div className="report-caveat" data-testid="text-report-disclaimer"><ShieldAlert size={15} /><p>{report.caveat}</p></div>
                    <div className="report-foot"><span>Generated locally · Sample outputs</span><span>Context retained from your question</span></div>
                  </article>
                ) : (
                  <div className={`report-empty ${running ? 'report-pending' : ''}`} data-testid="empty-final-report">
                    <div className="empty-report-icon">{running ? <Activity size={19} /> : <FileText size={19} />}</div>
                    <div className="empty-report-copy">
                      <h3>{running ? 'Synthesis follows agent review' : 'Your synthesis will appear here'}</h3>
                      <p>{running ? 'The Master Agent is coordinating specialist findings. The report appears when the review is complete.' : 'Submit a question to begin. The Master Agent will combine each simulated perspective into a concise, transparent report.'}</p>
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
                  {running ? <span className="activity-live"><i /> LIVE</span> : <span className="activity-local">LOCAL</span>}
                </div>
                <div className="activity-panel panel" data-testid="activity-feed">
                  {activity.length === 0 ? (
                    <div className="activity-empty" data-testid="empty-activity">
                      <div className="activity-empty-mark"><Activity size={17} /></div>
                      <strong>Quiet on the network</strong>
                      <p>When you start an analysis, each agent's progress and sample findings will appear here.</p>
                      <div className="empty-feed-line"><span /> WAITING FOR INPUT</div>
                    </div>
                  ) : (
                    <>
                      <div className="feed-label"><span>RUN TIMELINE</span><span>{activity.length.toString().padStart(2, '0')} EVENTS</span></div>
                      <ol className="activity-list">
                        {activity.map((entry, index) => (
                          <li className={`activity-entry ${index === 0 && running ? 'activity-current' : ''}`} key={entry.id} data-testid={`activity-entry-${entry.id}`}>
                            <span className="timeline-dot">{index === 0 && running ? <i /> : <Check size={11} />}</span>
                            <div className="activity-entry-content">
                              <div className="activity-entry-top"><b>{entry.agent}</b><time>{entry.time}</time></div>
                              <p>{entry.message}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="activity-foot">{running ? <><span className="activity-pulse" /> Sequence running</> : <><Check size={12} /> Local event log</>}</div>
                    </>
                  )}
                </div>
                <div className="activity-note"><ShieldAlert size={14} /><span>Sample events only. No live feeds or external connections.</span></div>
              </div>
            </aside>
          </div>

          <footer className="page-footer" id="disclaimer">
            <div className="footer-brand"><div className="footer-mark"><Command size={13} /></div><span>AMIN AI DESK</span><i /> ANALYSIS PROTOTYPE</div>
            <p>Local demonstration only. Outputs are illustrative, not live market analysis or investment advice.</p>
            <button onClick={() => jumpTo('Overview')} data-testid="button-back-to-top">BACK TO TOP <ArrowUpRight size={13} /></button>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
