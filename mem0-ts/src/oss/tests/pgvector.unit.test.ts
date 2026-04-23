/// <reference types="jest" />

const mockClients: Array<{
  connect: jest.Mock;
  end: jest.Mock;
  query: jest.Mock;
}> = [];

jest.mock("pg", () => {
  class MockClient {
    connect = jest.fn().mockResolvedValue(undefined);
    end = jest.fn().mockResolvedValue(undefined);
    query = jest.fn();

    constructor() {
      const clientIndex = mockClients.length;

      if (clientIndex === 0) {
        this.query.mockImplementation(async (sql: string) => {
          if (sql.includes("SELECT 1 FROM pg_database")) {
            return { rows: [{ exists: 1 }] };
          }
          throw new Error(`Unexpected bootstrap query: ${sql}`);
        });
      } else {
        this.query.mockImplementation(async (sql: string) => {
          if (sql.includes("CREATE EXTENSION IF NOT EXISTS vector")) {
            return { rows: [] };
          }
          if (sql.includes("CREATE TABLE IF NOT EXISTS memory_migrations")) {
            return { rows: [] };
          }
          if (sql.includes("FROM information_schema.tables")) {
            return { rows: [{ table_name: "memories" }] };
          }
          if (sql.includes("SELECT id, vector <=>")) {
            return {
              rows: [
                { id: "id-1", distance: 0.1, payload: { data: "nearest" } },
                { id: "id-2", distance: 0.8, payload: { data: "farther" } },
              ],
            };
          }
          throw new Error(`Unexpected pgvector query: ${sql}`);
        });
      }

      mockClients.push(this);
    }
  }

  return {
    __esModule: true,
    default: {
      Client: MockClient,
    },
  };
});

import { PGVector } from "../src/vector_stores/pgvector";

describe("PGVector.search()", () => {
  beforeEach(() => {
    mockClients.length = 0;
  });

  test("converts cosine distance into higher-is-better similarity", async () => {
    const store = new PGVector({
      user: "postgres",
      password: "postgres",
      host: "localhost",
      port: 5432,
      dbname: "mem0_test",
      collectionName: "memories",
      embeddingModelDims: 3,
    });

    await store.initialize();

    const results = await store.search([1, 0, 0], 2, { user_id: "u1" });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "id-1",
      payload: { data: "nearest" },
    });
    expect(results[0].score).toBeCloseTo(0.9);
    expect(results[1]).toMatchObject({
      id: "id-2",
      payload: { data: "farther" },
    });
    expect(results[1].score).toBeCloseTo(0.2);
  });
});
