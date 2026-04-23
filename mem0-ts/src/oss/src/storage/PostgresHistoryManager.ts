import { randomUUID } from "crypto";
import type { Pool as PoolType, PoolConfig, QueryResult } from "pg";
import pkg from "pg";
import { HistoryManager } from "./base";
import type { PostgresHistoryConfig } from "../types";

const { Pool } = pkg;

export class PostgresHistoryManager implements HistoryManager {
  private readonly pool: PoolType;
  private readonly schemaName: string;
  private readonly historyTableName: string;
  private readonly messagesTableName: string;
  private readonly initPromise: Promise<void>;
  private unavailable = false;
  private warnedUnavailable = false;

  constructor(config: PostgresHistoryConfig) {
    let poolConfig: PoolConfig;
    if ("connectionString" in config) {
      poolConfig = {
        connectionString: config.connectionString,
        ssl: config.ssl,
      };
    } else {
      const database = config.database || config.dbname;
      if (!config.host || !config.user || !database) {
        throw new Error(
          "Postgres history store requires either connectionString or host, user, and database/dbname config",
        );
      }

      poolConfig = {
        host: config.host,
        port: config.port || 5432,
        user: config.user,
        password: config.password,
        database,
        ssl: config.ssl,
      };
    }

    const schemaName = config.schema || "public";
    this.schemaName = this.quoteIdentifier(schemaName);
    this.historyTableName = this.qualifyIdentifier(
      schemaName,
      config.tableName || "memory_history",
    );
    this.messagesTableName = this.qualifyIdentifier(
      schemaName,
      config.messagesTableName || "messages",
    );
    this.pool = new Pool(poolConfig);
    this.initPromise = this.initializeTables();
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private qualifyIdentifier(schema: string, table: string): string {
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`;
  }

  private markUnavailable(message: string, error: unknown): void {
    this.unavailable = true;
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`${message}: ${detail}`);
    }
  }

  private async initializeTables(): Promise<void> {
    try {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaName}`);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.historyTableName} (
          id BIGSERIAL PRIMARY KEY,
          memory_id TEXT NOT NULL,
          previous_value TEXT,
          new_value TEXT,
          action TEXT NOT NULL,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ,
          is_deleted INTEGER DEFAULT 0
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.messagesTableName} (
          id TEXT PRIMARY KEY,
          session_scope TEXT,
          role TEXT,
          content TEXT,
          name TEXT,
          created_at TIMESTAMPTZ
        )
      `);
    } catch (error) {
      this.markUnavailable(
        "Failed to initialize Postgres history store",
        error,
      );
    }
  }

  private async query(
    text: string,
    values?: Array<string | number | null>,
  ): Promise<QueryResult | null> {
    if (this.unavailable) {
      return null;
    }

    await this.initPromise;

    if (this.unavailable) {
      return null;
    }

    try {
      return values === undefined
        ? await this.pool.query(text)
        : await this.pool.query(text, values);
    } catch (error) {
      this.markUnavailable(
        "Postgres history store became unavailable; continuing without history",
        error,
      );
      return null;
    }
  }

  async addHistory(
    memoryId: string,
    previousValue: string | null,
    newValue: string | null,
    action: string,
    createdAt?: string,
    updatedAt?: string,
    isDeleted: number = 0,
  ): Promise<void> {
    await this.query(
      `INSERT INTO ${this.historyTableName}
        (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        memoryId,
        previousValue,
        newValue,
        action,
        createdAt ?? null,
        updatedAt ?? null,
        isDeleted,
      ],
    );
  }

  async getHistory(memoryId: string): Promise<any[]> {
    const result = await this.query(
      `SELECT *
       FROM ${this.historyTableName}
       WHERE memory_id = $1
       ORDER BY id DESC`,
      [memoryId],
    );
    return result?.rows ?? [];
  }

  async saveMessages(
    messages: Array<{ role: string; content: string; name?: string }>,
    sessionScope: string,
  ): Promise<void> {
    if (!messages.length || this.unavailable) return;

    const now = new Date().toISOString();
    const values: Array<string | null> = [];
    const placeholders = messages.map((message, index) => {
      const offset = index * 6;
      values.push(
        randomUUID(),
        sessionScope,
        message.role,
        message.content,
        message.name ?? null,
        now,
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
    });

    const insertResult = await this.query(
      `INSERT INTO ${this.messagesTableName}
        (id, session_scope, role, content, name, created_at)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
    if (!insertResult) return;

    await this.query(
      `DELETE FROM ${this.messagesTableName}
       WHERE session_scope = $1
         AND id NOT IN (
           SELECT id FROM (
             SELECT id
             FROM ${this.messagesTableName}
             WHERE session_scope = $2
             ORDER BY created_at DESC
             LIMIT 10
           ) recent_messages
        )`,
      [sessionScope, sessionScope],
    );
  }

  async getLastMessages(
    sessionScope: string,
    limit = 10,
  ): Promise<
    Array<{ role: string; content: string; name?: string; createdAt: string }>
  > {
    const result = await this.query(
      `SELECT role, content, name, created_at
       FROM (
         SELECT role, content, name, created_at
         FROM ${this.messagesTableName}
         WHERE session_scope = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent_messages
       ORDER BY created_at ASC`,
      [sessionScope, limit],
    );

    return (result?.rows ?? []).map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.name != null ? { name: row.name } : {}),
      createdAt: row.created_at,
    }));
  }

  async batchAddHistory(
    records: Array<{
      memoryId: string;
      previousValue: string | null;
      newValue: string | null;
      action: string;
      createdAt?: string;
      updatedAt?: string;
      isDeleted?: number;
    }>,
  ): Promise<void> {
    if (!records.length || this.unavailable) return;

    const values: Array<string | number | null> = [];
    const placeholders = records.map((record, index) => {
      const offset = index * 7;
      values.push(
        record.memoryId,
        record.previousValue,
        record.newValue,
        record.action,
        record.createdAt ?? null,
        record.updatedAt ?? null,
        record.isDeleted ?? 0,
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
    });

    await this.query(
      `INSERT INTO ${this.historyTableName}
        (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
  }

  async reset(): Promise<void> {
    if (this.unavailable) return;

    const historyResult = await this.query(
      `TRUNCATE TABLE ${this.historyTableName} RESTART IDENTITY`,
    );
    if (!historyResult) return;

    await this.query(`TRUNCATE TABLE ${this.messagesTableName}`);
  }

  close(): void {
    void this.pool.end();
  }
}
