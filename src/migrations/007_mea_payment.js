import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`DROP INDEX IF EXISTS stash.ix_mea_electric_bill_no_normalized`.execute(db)

  await db.schema
    .alterTable('stash.mea_electric')
    .dropColumn('payment_synced_at')
    .dropColumn('payment_channel_sap')
    .dropColumn('payment_channel')
    .dropColumn('receipt_no')
    .dropColumn('payment_amount')
    .dropColumn('outstanding_amount')
    .dropColumn('due_date')
    .dropColumn('paid_at')
    .dropColumn('payment_status')
    .dropColumn('payment_bill_no')
    .dropColumn('bill_no_normalized')
    .execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable('stash.mea_electric')
    .addColumn('bill_no_normalized', 'varchar(20)')
    .addColumn('payment_bill_no', 'varchar(20)')
    .addColumn('payment_status', 'varchar(20)')
    .addColumn('paid_at', 'date')
    .addColumn('due_date', 'date')
    .addColumn('outstanding_amount', 'numeric')
    .addColumn('payment_amount', 'numeric')
    .addColumn('receipt_no', 'varchar(40)')
    .addColumn('payment_channel', 'varchar(120)')
    .addColumn('payment_channel_sap', 'varchar(20)')
    .addColumn('payment_synced_at', 'timestamptz')
    .execute()

  // MEA bill numbers are 11-digit identifiers. Keep the source value in bill_no and use this
  // normalized copy only for matching APIs that inconsistently omit leading zeroes.
  await sql`
    UPDATE stash.mea_electric
    SET bill_no_normalized = CASE
      WHEN bill_no ~ '^[0-9]+$' THEN lpad(bill_no, 11, '0')
      ELSE bill_no
    END
    WHERE bill_no IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX ix_mea_electric_bill_no_normalized
    ON stash.mea_electric (ca, bill_no_normalized)
    WHERE bill_no_normalized IS NOT NULL
  `.execute(db)
}
