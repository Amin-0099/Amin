import {
  boolean,
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

export const radarSignals = pgTable(
  "radar_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalKey: text("signal_key").notNull(),
    asset: text("asset").notNull(),
    signalType: text("signal_type").notNull(),
    stance: text("stance").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    referencePriceUsdt: numeric("reference_price_usdt", { precision: 24, scale: 10 }),
    dataStatus: text("data_status").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("radar_signals_signal_key_uq").on(table.signalKey),
    index("radar_signals_asset_observed_idx").on(table.asset, table.observedAt),
  ],
);

export const radarSignalOutcomes = pgTable(
  "radar_signal_outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => radarSignals.id, { onDelete: "cascade" }),
    horizonHours: integer("horizon_hours").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    outcomePriceUsdt: numeric("outcome_price_usdt", { precision: 24, scale: 10 }).notNull(),
    returnPercent: numeric("return_percent", { precision: 12, scale: 6 }).notNull(),
    directionCorrect: boolean("direction_correct"),
    source: text("source").notNull(),
  },
  (table) => [
    uniqueIndex("radar_signal_outcomes_signal_horizon_uq").on(table.signalId, table.horizonHours),
    index("radar_signal_outcomes_horizon_idx").on(table.horizonHours, table.evaluatedAt),
  ],
);
