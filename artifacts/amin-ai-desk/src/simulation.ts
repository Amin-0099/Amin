export type AgentStatus = 'Idle' | 'Working' | 'Complete';
export type MarketScenario = 'constructive' | 'cautious' | 'mixed';

export type Agent = {
  id: string;
  name: string;
  specialty: string;
  status: AgentStatus;
  result: string;
};

export type RiskAssessment = {
  assessment: string;
  risks: string[];
  evidenceNote: string;
};

export type SpecialistStance = 'bullish' | 'bearish' | 'neutral';

export type SpecialistFinding = {
  summary: string;
  stance: SpecialistStance;
  evidenceNote: string;
};

export type VerificationReview = {
  summary: string;
  contradictions: string[];
  weakEvidence: string[];
};

export type FinalReport = {
  question: string;
  headline: string;
  summary: string;
  bullishSignals: string[];
  bearishSignals: string[];
  riskAssessment: string;
  risks: string[];
  confidenceScore: number;
  confidenceLabel: string;
  conclusion: string;
  verification: VerificationReview;
  caveat: string;
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

export const firstWaveAgentIds = [
  'market',
  'news',
  'social',
  'onchain',
  'technical',
  'momentum',
] as const;

const scenarioProfiles: Record<
  MarketScenario,
  {
    summary: string;
    bullishSignals: string[];
    bearishSignals: string[];
    confidenceScore: number;
    conclusion: string;
  }
> = {
  constructive: {
    summary:
      'The local demo profile is constructive but not confirmed. The simulated market, technical, and momentum perspectives lean positive, while other lenses remain neutral.',
    bullishSignals: [
      'Market structure and technical trend lean constructive in the demo profile.',
      'Momentum and sentiment offer a modest positive signal.',
      'Several simulated perspectives align on possible continuation if confirmation appears.',
    ],
    bearishSignals: [
      'News and on-chain perspectives remain neutral rather than confirming the positive view.',
      'No real price, volume, news, sentiment, or network evidence was checked.',
      'The positive profile is not a verified market signal.',
    ],
    confidenceScore: 31,
    conclusion:
      'Constructive demo scenario, unconfirmed. Treat the profile as an illustration of how agents combine perspectives, not as a real-world market call.',
  },
  cautious: {
    summary:
      'The local demo profile is cautious. Simulated market, news, technical, and momentum perspectives lean defensive, while sentiment is not a reliable counter-signal.',
    bullishSignals: [
      'The simulated sentiment perspective does not show strong downside conviction.',
      'A neutral on-chain profile leaves room for conditions to stabilize.',
    ],
    bearishSignals: [
      'Market structure and technical perspectives lean defensive in the demo profile.',
      'Momentum and the sample narrative do not confirm a recovery.',
      'No real price, volume, news, sentiment, or network evidence was checked.',
    ],
    confidenceScore: 28,
    conclusion:
      'Cautious demo scenario, unconfirmed. The sample outputs favor downside awareness, but they are not evidence of actual market direction.',
  },
  mixed: {
    summary:
      'The local demo profile is mixed. Sentiment and momentum lean constructive, while the technical view is cautious and the other perspectives do not resolve the disagreement.',
    bullishSignals: [
      'Simulated sentiment and momentum show modest constructive signals.',
      'The sample market and on-chain perspectives do not identify a strong downside confirmation.',
    ],
    bearishSignals: [
      'The simulated technical perspective does not confirm the positive sentiment and momentum.',
      'News and on-chain perspectives are neutral, leaving the directional case unresolved.',
      'No real price, volume, news, sentiment, or network evidence was checked.',
    ],
    confidenceScore: 24,
    conclusion:
      'Mixed demo scenario. The simulated perspectives conflict, so the final output remains neutral and explicitly unconfirmed.',
  },
};

export function getMarketScenario(question: string): MarketScenario {
  const text = question.toLowerCase();
  const bullishCues = [
    'bullish',
    'upside',
    'rally',
    'breakout',
    'growth',
    'higher',
    'strength',
    'positive',
  ];
  const bearishCues = [
    'bearish',
    'downside',
    'decline',
    'selloff',
    'drop',
    'weakness',
    'negative',
    'crash',
  ];
  const bullishCount = bullishCues.filter((cue) => text.includes(cue)).length;
  const bearishCount = bearishCues.filter((cue) => text.includes(cue)).length;

  if (bullishCount > bearishCount) return 'constructive';
  if (bearishCount > bullishCount) return 'cautious';
  return 'mixed';
}

export function createIdleAgents(): Agent[] {
  return agentBlueprints.map((agent) => ({
    ...agent,
    status: 'Idle',
    result: '',
  }));
}

export function createSpecialistResult(
  agentId: (typeof firstWaveAgentIds)[number],
  scenario: MarketScenario,
): SpecialistFinding {
  const findings: Record<
    (typeof firstWaveAgentIds)[number],
    Record<MarketScenario, string>
  > = {
    market: {
      constructive:
        'Simulated market read: structure leans constructive, but the demo has no price or liquidity feed to confirm it.',
      cautious:
        'Simulated market read: structure leans defensive; there is no live price or liquidity data to validate that view.',
      mixed:
        'Simulated market read: conditions are unresolved. No price or liquidity feed is connected.',
    },
    news: {
      constructive:
        'Simulated news read: the sample narrative is modestly supportive. No headlines were retrieved or verified.',
      cautious:
        'Simulated news read: the sample narrative is cautious. No headlines were retrieved or verified.',
      mixed:
        'Simulated news read: the narrative is mixed. No headlines were retrieved or verified.',
    },
    social: {
      constructive:
        'Simulated sentiment read: crowd tone is cautiously optimistic in this demo profile. No social posts were analyzed.',
      cautious:
        'Simulated sentiment read: crowd tone is hesitant in this demo profile. No social posts were analyzed.',
      mixed:
        'Simulated sentiment read: sentiment leans optimistic, but conviction is uneven. No social posts were analyzed.',
    },
    onchain: {
      constructive:
        'Simulated on-chain read: activity is steady in the demo profile. No blockchain or wallet data was queried.',
      cautious:
        'Simulated on-chain read: activity is neutral and does not confirm the cautious scenario. No blockchain data was queried.',
      mixed:
        'Simulated on-chain read: activity is neutral and does not resolve the mixed signals. No blockchain data was queried.',
    },
    technical: {
      constructive:
        'Simulated technical read: trend bias is constructive, but a confirming move is still required. No chart data is connected.',
      cautious:
        'Simulated technical read: trend bias is cautious, but no chart or price levels were checked.',
      mixed:
        'Simulated technical read: price structure is cautious and conflicts with the positive sentiment profile. No chart data is connected.',
    },
    momentum: {
      constructive:
        'Simulated momentum read: momentum leans positive, with follow-through unconfirmed. No live prices or volume were checked.',
      cautious:
        'Simulated momentum read: momentum leans weak in this demo profile. No live prices or volume were checked.',
      mixed:
        'Simulated momentum read: momentum leans positive, but the move lacks confirmation. No live prices or volume were checked.',
    },
  };

  const stances: Record<
    MarketScenario,
    Record<(typeof firstWaveAgentIds)[number], SpecialistStance>
  > = {
    constructive: {
      market: 'bullish',
      news: 'neutral',
      social: 'bullish',
      onchain: 'neutral',
      technical: 'bullish',
      momentum: 'bullish',
    },
    cautious: {
      market: 'bearish',
      news: 'bearish',
      social: 'neutral',
      onchain: 'neutral',
      technical: 'bearish',
      momentum: 'bearish',
    },
    mixed: {
      market: 'neutral',
      news: 'neutral',
      social: 'bullish',
      onchain: 'neutral',
      technical: 'bearish',
      momentum: 'bullish',
    },
  };
  const evidenceNotes: Record<(typeof firstWaveAgentIds)[number], string> = {
    market: 'No market or liquidity source was connected.',
    news: 'No headlines or source timestamps were retrieved.',
    social: 'No posts or social-platform source data were analyzed.',
    onchain: 'No blockchain or wallet source data was queried.',
    technical: 'No chart, price series, or indicator data was checked.',
    momentum: 'No live price or volume data was checked.',
  };

  return {
    summary: findings[agentId][scenario],
    stance: stances[scenario][agentId],
    evidenceNote: evidenceNotes[agentId],
  };
}

export function createRiskAssessment(
  scenario: MarketScenario,
): RiskAssessment {
  const scenarioRisk =
    scenario === 'constructive'
      ? 'A false breakout could reverse the constructive demo profile before confirmation.'
      : scenario === 'cautious'
        ? 'A rapid reversal could invalidate the cautious demo profile; no live conditions were evaluated.'
        : 'Conflicting demo signals increase the risk of drawing a directional conclusion from incomplete evidence.';

  return {
    assessment: `${scenarioRisk} All inputs are simulated, and the absence of live sources is itself a major evidence risk.`,
    risks: [
      'No live price, volume, headline, social, or on-chain sources are connected.',
      'The sample profile is selected from wording in the question, not observed market conditions.',
      'A real-world event or sudden liquidity change is outside this simulation.',
    ],
    evidenceNote:
      'The risk assessment is a local mock and has no live price, volatility, liquidity, or event data behind it.',
  };
}

export function createVerificationReview(
  findings: Partial<Record<(typeof firstWaveAgentIds)[number], SpecialistFinding>>,
  riskAssessment: RiskAssessment,
): VerificationReview {
  const reviewedIds = firstWaveAgentIds.filter((id) => findings[id]);
  const bullishIds = reviewedIds.filter((id) => findings[id]?.stance === 'bullish');
  const bearishIds = reviewedIds.filter((id) => findings[id]?.stance === 'bearish');
  const neutralIds = reviewedIds.filter((id) => findings[id]?.stance === 'neutral');
  const agentNames = (ids: readonly string[]) =>
    ids.map((id) => agentBlueprints.find((agent) => agent.id === id)?.name ?? id).join(', ');
  const contradictions: string[] = [];

  if (bullishIds.length && bearishIds.length) {
    contradictions.push(
      `Directional conflict: ${agentNames(bullishIds)} lean bullish while ${agentNames(bearishIds)} lean bearish.`,
    );
  } else if (neutralIds.length) {
    contradictions.push(
      `${agentNames(neutralIds)} do not confirm the directional view from the other specialists.`,
    );
  } else {
    contradictions.push('No directional conflict was found among the completed specialist stances.');
  }

  const evidenceGaps = reviewedIds
    .map((id) => findings[id]?.evidenceNote)
    .filter((note): note is string => Boolean(note));
  const directionalNote = bullishIds.length && bearishIds.length
    ? 'The findings disagree directionally; the disagreement is retained rather than averaged away.'
    : 'The available simulated stances are directionally closer, but alignment alone does not make them verified.';

  return {
    summary: `Reviewed ${reviewedIds.length} specialist outputs and the separate Risk Analyst assessment. ${directionalNote} No claim can be verified against live evidence.`,
    contradictions,
    weakEvidence: [...evidenceGaps, riskAssessment.evidenceNote],
  };
}

export function createFinalReport(
  question: string,
  scenario: MarketScenario,
  riskAssessment: RiskAssessment,
  verification: VerificationReview,
): FinalReport {
  const profile = scenarioProfiles[scenario];
  const conclusion = [
    profile.conclusion,
    verification.summary,
    `Priority risk: ${riskAssessment.risks[0]}`,
  ].join(' ');

  return {
    question,
    headline:
      scenario === 'mixed'
        ? 'Conflicting signals remain unverified'
        : 'A simulated view requiring confirmation',
    summary: `${profile.summary} Verification found weak evidence: ${verification.summary}`,
    bullishSignals: profile.bullishSignals,
    bearishSignals: profile.bearishSignals,
    riskAssessment: riskAssessment.assessment,
    risks: riskAssessment.risks,
    confidenceScore: profile.confidenceScore,
    confidenceLabel: 'Low · demo consistency only',
    conclusion,
    verification,
    caveat:
      'This report is generated from local mock profiles selected using the question text. It does not use live market data, is not financial advice, and does not execute trades.',
  };
}
