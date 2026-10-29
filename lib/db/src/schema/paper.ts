import { sql } from "drizzle-orm";
import {
  integer,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { analysisRuns } from "./analysis";
import { radarSignals } from "./radar";

export type StoredScoreWeights = {
  trend: number;
  ema: number;
  rsi: number;
  atr: number;
  momentum: number;
  volume: number;
  breakout: number;
  news: number;
  sentiment: number;
  macro: number;
  risk: number;
  consensus: number;
};

export const paperAccounts = pgTable("paper_accounts", {
  accountId: text("account_id").primaryKey(),
  startingBalanceEur: numeric("starting_balance_eur", { precision: 14, scale: 2 })
    .notNull()
    .default("10000"),
  cashBalanceEur: numeric("cash_balance_eur", { precision: 14, scale: 2 })
    .notNull()
    .default("10000"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperSettings = pgTable("paper_settings", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => paperAccounts.accountId, { onDelete: "cascade" }),
  scoreWeights: jsonb("score_weights")
    .$type<StoredScoreWeights>()
    .notNull()
    .default({
      trend: 12,
      ema: 12,
      rsi: 8,
      atr: 6,
      momentum: 12,
      volume: 10,
      breakout: 10,
      news: 5,
      sentiment: 5,
      macro: 5,
      risk: 8,
      consensus: 7,
    }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperTrades = pgTable(
  "paper_trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.accountId, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
    signalId: uuid("signal_id").references(() => radarSignals.id, { onDelete: "set null" }),
    asset: text("asset").notNull(),
    side: text("side").notNull(),
    notionalEur: numeric("notional_eur", { precision: 14, scale: 2 }).notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 12 }).notNull(),
    entryPriceEur: numeric("entry_price_eur", { precision: 24, scale: 10 }).notNull(),
    feeRateBps: integer("fee_rate_bps").notNull().default(10),
    entryFeeEur: numeric("entry_fee_eur", { precision: 14, scale: 2 }).notNull().default("0"),
    exitFeeEur: numeric("exit_fee_eur", { precision: 14, scale: 2 }).notNull().default("0"),
    stopLossEur: numeric("stop_loss_eur", { precision: 24, scale: 10 }),
    takeProfitEur: numeric("take_profit_eur", { precision: 24, scale: 10 }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    exitPriceEur: numeric("exit_price_eur", { precision: 24, scale: 10 }),
    realizedPnlEur: numeric("realized_pnl_eur", { precision: 14, scale: 2 }),
    closeReason: text("close_reason"),
    signalSnapshot: jsonb("signal_snapshot").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("paper_trades_account_opened_idx").on(table.accountId, table.openedAt),
    index("paper_trades_run_idx").on(table.runId),
    uniqueIndex("paper_trades_account_signal_uq")
      .on(table.accountId, table.signalId)
      .where(sql`${table.signalId} IS NOT NULL`),
  ],
);
