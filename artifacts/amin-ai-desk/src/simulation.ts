export type AgentStatus = 'Idle' | 'Working' | 'Finished';

export type Agent = {
  id: string;
  name: string;
  specialty: string;
  status: AgentStatus;
  result: string;
};

export const agentBlueprints = [
  { id: 'master', name: 'Master Agent', specialty: 'Orchestration & synthesis' },
  { id: 'market', name: 'Market Scanner', specialty: 'Market structure' },
  { id: 'news', name: 'News Analyst', specialty: 'Narrative context' },
  { id: 'social', name: 'Social Sentiment', specialty: 'Crowd positioning' },
  { id: 'onchain', name: 'On-Chain Analyst', specialty: 'Network activity' },
  { id: 'technical', name: 'Technical Analyst', specialty: 'Price structure' },
  { id: 'momentum', name: 'Momentum Scanner', specialty: 'Trend strength' },
  { id: 'risk', name: 'Risk Analyst', specialty: 'Downside scenarios' },
  { id: 'verification', name: 'Verification Agent', specialty: 'Cross-checks' },
  { id: 'decision', name: 'Final Decision Agent', specialty: 'Balanced conclusion' },
] as const;

export const sampleResults: Record<string, string> = {
  market: 'Range-bound conditions; liquidity appears concentrated near recent highs and lows.',
  news: 'The sample narrative is mixed, with no single catalyst dominating the scenario.',
  social: 'Conversation tone is cautiously optimistic; conviction appears uneven.',
  onchain: 'Illustrative network activity is steady, without a clear acceleration signal.',
  technical: 'Price structure is consolidating. A sustained break would be needed to confirm direction.',
  momentum: 'Momentum reads neutral-to-positive, but follow-through remains unconfirmed.',
  risk: 'Key risk: a failed breakout could return price to the center of the current range.',
  verification: 'Cross-check complete. Inputs are simulated and do not represent live observations.',
  decision: 'Evidence is mixed. Maintain a watchful, scenario-based view; avoid treating this as a signal.',
};

export const stagedAgentIds = [
  'market', 'news', 'social', 'onchain', 'technical',
  'momentum', 'risk', 'verification', 'decision',
];

export function createIdleAgents(): Agent[] {
  return agentBlueprints.map((agent) => ({
    ...agent,
    status: 'Idle',
    result: '',
  }));
}

export function createSampleReport(question: string) {
  return {
    question,
    headline: 'A mixed picture calls for confirmation',
    summary:
      'The simulated agents point to a market in consolidation: there are constructive signals in momentum and sentiment, but no strong confirmation across the full set of lenses. The more useful frame is a set of conditions to monitor rather than a directional call.',
    signals: [
      { label: 'Trend', value: 'Neutral, slight positive bias', tone: 'teal' },
      { label: 'Conviction', value: 'Moderate–low', tone: 'amber' },
      { label: 'Risk posture', value: 'Wait for confirmation', tone: 'slate' },
    ],
    watch:
      'Watch for a sustained move beyond the current range, then reassess whether volume, sentiment, and network activity confirm the same direction.',
    caveat:
      'This is a locally generated demonstration report using hard-coded sample outputs. It does not use live market data and is not financial advice.',
  };
}
