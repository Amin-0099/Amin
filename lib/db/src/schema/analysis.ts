import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type StoredEvidence = {
  metric: string;
  value: string;
  source: string;
  timestamp: string;
  dataStatus: "live" | "stale" | "missing";
};

export type StoredSourceStatus = {
  source: string;
  status: "live" | "stale" | "missing";
  checkedAt: string;
  observedAt: string | null;
  ageMinutes: number | null;
  detail: string;
};

export type StoredAgentOutput = {
  agentId: string;
  status: "idle" | "working" | "complete" | "error";
  stance: "bullish" | "bearish" | "neutral" | "not_evaluable";
  summary: string;
  confidence: number;
  bullishFactors: string[];
  bearishFactors: string[];
  risks: string[];
  rationale: string;
  evidence: StoredEvidence[];
  source: string;
  timestamp: string;
  dataStatus: "live" | "stale" | "missing";
  dataSources: StoredSourceStatus[];
  error: string | null;
};

export type StoredRunEvent = {
  id: number;
  agent: string;
  message: string;
  timestamp: string;
  kind: "info" | "working" | "complete" | "error";
};

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: text("account_id").notNull(),
    asset: text("asset").notNull(),
    question: text("question").notNull(),
    status: text("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    confidence: integer("confidence"),
    finalReport: jsonb("final_report").$type<Record<string, unknown> | null>(),
    activity: jsonb("activity").$type<StoredRunEvent[]>().notNull().default([]),
    error: text("error"),
  },
  (table) => [
    index("analysis_runs_account_created_idx").on(table.accountId, table.createdAt),
  ],
);

export const analysisAgentOutputs = pgTable(
  "analysis_agent_outputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull().default("idle"),
    stance: text("stance").notNull().default("not_evaluable"),
    summary: text("summary").notNull().default("Waiting for this agent to run."),
    confidence: integer("confidence").notNull().default(0),
    bullishFactors: jsonb("bullish_factors").$type<string[]>().notNull().default([]),
    bearishFactors: jsonb("bearish_factors").$type<string[]>().notNull().default([]),
    risks: jsonb("risks").$type<string[]>().notNull().default([]),
    rationale: text("rationale").notNull().default(""),
    evidence: jsonb("evidence").$type<StoredEvidence[]>().notNull().default([]),
    source: text("source").notNull().default(""),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    dataStatus: text("data_status").notNull().default("missing"),
    dataSources: jsonb("data_sources")
      .$type<StoredSourceStatus[]>()
      .notNull()
      .default([]),
    error: text("error"),
    rawSnapshot: jsonb("raw_snapshot").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    uniqueIndex("analysis_agent_outputs_run_agent_uq").on(table.runId, table.agentId),
    index("analysis_agent_outputs_run_idx").on(table.runId),
  ],
);
