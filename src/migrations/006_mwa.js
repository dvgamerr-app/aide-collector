import { sql } from 'kysely'

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable('stash.mwa_water').execute()
  await db.schema.dropTable('stash.mwa_account').execute()
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable('stash.mwa_account')
    .ifNotExists()
    .addColumn('account_code', 'varchar(20)', (col) => col.primaryKey())
    .addColumn('branch_code', 'varchar(20)')
    .addColumn('branch_name', 'varchar(120)')
    .addColumn('zone', 'varchar(20)')
    .addColumn('status_code', 'varchar(20)')
    .addColumn('status_description', 'varchar(120)')
    .addColumn('meter_size_code', 'varchar(20)')
    .addColumn('meter_size_description', 'varchar(120)')
    .addColumn('class_code', 'varchar(20)')
    .addColumn('class_description', 'varchar(120)')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('stash.mwa_water')
    .ifNotExists()
    .addColumn('account_code', 'varchar(20)', (col) => col.notNull())
    .addColumn('bill_number', 'varchar(40)', (col) => col.notNull())
    .addColumn('receive_code', 'varchar(20)', (col) => col.notNull())
    .addColumn('receive_sub_code', 'integer', (col) => col.notNull())
    .addColumn('receipt_number', 'varchar(40)')
    .addColumn('receive_ref_seq_number', 'bigint')
    .addColumn('period_year', 'integer')
    .addColumn('period_month', 'integer')
    .addColumn('bill_date', 'date')
    .addColumn('bill_due_date', 'date')
    .addColumn('current_read_date', 'date')
    .addColumn('paid_date', 'date')
    .addColumn('receive_date', 'date')
    .addColumn('consumption', 'numeric', (col) => col.defaultTo(0))
    .addColumn('gross_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('vat_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('paid_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('balance_gross_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('balance_water_charge_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('balance_meter_fee_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('balance_raw_amount', 'numeric', (col) => col.defaultTo(0))
    .addColumn('vat_type', 'varchar(20)')
    .addColumn('vat_rate', 'numeric', (col) => col.defaultTo(0))
    .addColumn('payment_flag', 'varchar(10)')
    .addColumn('collect_type', 'varchar(20)')
    .addColumn('collect_type_description', 'varchar(120)')
    .addColumn('receive_description', 'varchar(120)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('pk_mwa_water', ['account_code', 'bill_number', 'receive_code', 'receive_sub_code'])
    .execute()

  await sql`CREATE INDEX IF NOT EXISTS ix_mwa_water_period ON stash.mwa_water (account_code, period_year, period_month)`.execute(db)
}
