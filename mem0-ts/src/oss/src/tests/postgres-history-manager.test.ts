jest.mock("pg", () => {
  const queryMock = jest.fn();
  const endMock = jest.fn().mockResolvedValue(undefined);
  const PoolMock = jest.fn().mockImplementation(() => ({
    query: queryMock,
    end: endMock,
  }));

  return {
    __esModule: true,
    default: {
      Pool: PoolMock,
      __mock: { queryMock, endMock, PoolMock },
    },
  };
});

import pg from "pg";
import { ConfigManager } from "../config/manager";
import { PostgresHistoryManager } from "../storage/PostgresHistoryManager";
import type { PostgresHistoryConfig } from "../types";

const pgMock = (pg as any).__mock as {
  queryMock: jest.Mock;
  endMock: jest.Mock;
  PoolMock: jest.Mock;
};

describe("ConfigManager.mergeConfig – postgres history store", () => {
  it("preserves postgres history store config", () => {
    const cfg = ConfigManager.mergeConfig({
      historyStore: {
        provider: "postgres",
        config: {
          host: "localhost",
          port: 5432,
          user: "mem0",
          password: "secret",
          database: "mem0_history",
          schema: "custom",
          tableName: "history_log",
          messagesTableName: "session_messages",
        },
      },
    });

    expect(cfg.historyStore?.provider).toBe("postgres");
    if (
      !cfg.historyStore ||
      cfg.historyStore.provider !== "postgres" ||
      !("host" in cfg.historyStore.config)
    ) {
      throw new Error("Expected postgres history store with host config");
    }

    expect(cfg.historyStore.config.host).toBe("localhost");
    expect(cfg.historyStore.config.database).toBe("mem0_history");
    expect(cfg.historyStore.config.schema).toBe("custom");
    expect(cfg.historyStore.config.tableName).toBe("history_log");
    expect(cfg.historyStore.config.messagesTableName).toBe("session_messages");
  });
});

describe("PostgresHistoryManager", () => {
  beforeEach(() => {
    pgMock.queryMock.mockReset();
    pgMock.queryMock.mockResolvedValue({ rows: [] });
    pgMock.endMock.mockClear();
    pgMock.PoolMock.mockClear();
  });

  it("creates a pool from connectionString and initializes tables", async () => {
    const manager = new PostgresHistoryManager({
      connectionString: "postgresql://user:pass@localhost:5432/mem0",
      schema: "custom",
      tableName: "history_log",
      messagesTableName: "session_messages",
    });

    await manager.addHistory("mem-1", null, "new", "ADD");

    expect(pgMock.PoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgresql://user:pass@localhost:5432/mem0",
      }),
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      1,
      'CREATE SCHEMA IF NOT EXISTS "custom"',
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS "custom"."history_log"',
      ),
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS "custom"."session_messages"',
      ),
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO "custom"."history_log"'),
      ["mem-1", null, "new", "ADD", null, null, 0],
    );
  });

  it("supports discrete connection config, history reads, batch inserts, and reset", async () => {
    pgMock.queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 2, memory_id: "mem-2", action: "UPDATE" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const manager = new PostgresHistoryManager({
      host: "localhost",
      port: 5432,
      user: "mem0",
      password: "secret",
      database: "mem0_history",
    });

    const history = await manager.getHistory("mem-2");
    await manager.batchAddHistory([
      {
        memoryId: "mem-2",
        previousValue: null,
        newValue: "first",
        action: "ADD",
        createdAt: "2026-04-20T10:00:00.000Z",
      },
      {
        memoryId: "mem-2",
        previousValue: "first",
        newValue: "second",
        action: "UPDATE",
        updatedAt: "2026-04-20T10:05:00.000Z",
        isDeleted: 0,
      },
    ]);
    await manager.reset();

    expect(pgMock.PoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "localhost",
        port: 5432,
        user: "mem0",
        password: "secret",
        database: "mem0_history",
      }),
    );
    expect(history).toEqual([{ id: 2, memory_id: "mem-2", action: "UPDATE" }]);
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('FROM "public"."memory_history"'),
      ["mem-2"],
    );
    expect((pgMock.queryMock.mock.calls[3]?.[0] as string) || "").not.toContain(
      "LIMIT 100",
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('INSERT INTO "public"."memory_history"'),
      [
        "mem-2",
        null,
        "first",
        "ADD",
        "2026-04-20T10:00:00.000Z",
        null,
        0,
        "mem-2",
        "first",
        "second",
        "UPDATE",
        null,
        "2026-04-20T10:05:00.000Z",
        0,
      ],
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      6,
      'TRUNCATE TABLE "public"."memory_history" RESTART IDENTITY',
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      7,
      'TRUNCATE TABLE "public"."messages"',
    );
  });

  it("stores and retrieves recent messages in chronological order", async () => {
    pgMock.queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            role: "user",
            content: "hello",
            name: null,
            created_at: "2026-04-20T10:00:00.000Z",
          },
          {
            role: "assistant",
            content: "hi",
            name: "mem0",
            created_at: "2026-04-20T10:00:01.000Z",
          },
        ],
      });

    const manager = new PostgresHistoryManager({
      connectionString: "postgresql://user:pass@localhost:5432/mem0",
    });

    await manager.saveMessages(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi", name: "mem0" },
      ],
      "agent_id=test",
    );
    const messages = await manager.getLastMessages("agent_id=test", 2);

    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO "public"."messages"'),
      expect.arrayContaining([
        "agent_id=test",
        "user",
        "hello",
        null,
        "assistant",
        "hi",
        "mem0",
      ]),
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('DELETE FROM "public"."messages"'),
      ["agent_id=test", "agent_id=test"],
    );
    expect(pgMock.queryMock).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining('FROM "public"."messages"'),
      ["agent_id=test", 2],
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: "hello",
        createdAt: "2026-04-20T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "hi",
        name: "mem0",
        createdAt: "2026-04-20T10:00:01.000Z",
      },
    ]);
  });

  it("throws when neither connectionString nor required discrete config is provided", () => {
    expect(
      () =>
        new PostgresHistoryManager({
          host: "localhost",
          database: "mem0",
        } as unknown as PostgresHistoryConfig),
    ).toThrow(
      "Postgres history store requires either connectionString or host, user, and database/dbname config",
    );
  });

  it("degrades to history unavailable when postgres initialization fails", async () => {
    pgMock.queryMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const manager = new PostgresHistoryManager({
      connectionString: "postgresql://user:pass@localhost:5432/mem0",
    });

    await expect(manager.addHistory("mem-1", null, "new", "ADD")).resolves.toBe(
      undefined,
    );
    await expect(manager.getHistory("mem-1")).resolves.toEqual([]);
    await expect(
      manager.saveMessages(
        [{ role: "user", content: "hello" }],
        "session=test",
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to initialize Postgres history store: connect ECONNREFUSED",
    );
    expect(pgMock.queryMock).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("degrades to history unavailable after a runtime postgres failure", async () => {
    pgMock.queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new PostgresHistoryManager({
      connectionString: "postgresql://user:pass@localhost:5432/mem0",
    });

    await expect(manager.addHistory("mem-1", null, "new", "ADD")).resolves.toBe(
      undefined,
    );
    await expect(manager.getHistory("mem-1")).resolves.toEqual([]);
    await expect(
      manager.saveMessages(
        [{ role: "user", content: "hello" }],
        "session=test",
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Postgres history store became unavailable; continuing without history",
      ),
    );
    expect(pgMock.queryMock).toHaveBeenCalledTimes(4);

    warnSpy.mockRestore();
  });

  it("closes the underlying pool", () => {
    const manager = new PostgresHistoryManager({
      connectionString: "postgresql://user:pass@localhost:5432/mem0",
    });

    manager.close();

    expect(pgMock.endMock).toHaveBeenCalledTimes(1);
  });
});
