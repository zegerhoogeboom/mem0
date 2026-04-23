import { z } from "zod";

export interface MultiModalMessages {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface Message {
  role: string;
  content: string | MultiModalMessages;
}

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string | any;
  baseURL?: string;
  url?: string;
  embeddingDims?: number;
  modelProperties?: Record<string, any>;
}

export interface VectorStoreConfig {
  collectionName?: string;
  dimension?: number;
  dbPath?: string;
  client?: any;
  instance?: any;
  [key: string]: any;
}

export interface SQLiteHistoryStoreConfig {
  provider: "sqlite";
  config: {
    historyDbPath?: string;
  };
}

export interface SupabaseHistoryStoreConfig {
  provider: "supabase";
  config: {
    supabaseUrl: string;
    supabaseKey: string;
    tableName?: string;
  };
}

interface PostgresHistoryBaseConfig {
  schema?: string;
  tableName?: string;
  messagesTableName?: string;
  ssl?: any;
}

type PostgresHistoryConnectionStringConfig = PostgresHistoryBaseConfig & {
  connectionString: string;
};

type PostgresHistoryDiscreteConfig = PostgresHistoryBaseConfig & {
  host: string;
  port?: number;
  user: string;
  password?: string;
} & (
    | { database: string; dbname?: string }
    | { database?: string; dbname: string }
  );

export type PostgresHistoryConfig =
  | PostgresHistoryConnectionStringConfig
  | PostgresHistoryDiscreteConfig;

export interface PostgresHistoryStoreConfig {
  provider: "postgres";
  config: PostgresHistoryConfig;
}

export interface MemoryHistoryStoreConfig {
  provider: "memory";
  config: Record<string, never>;
}

export type HistoryStoreConfig =
  | SQLiteHistoryStoreConfig
  | SupabaseHistoryStoreConfig
  | PostgresHistoryStoreConfig
  | MemoryHistoryStoreConfig;

export interface LLMConfig {
  provider?: string;
  baseURL?: string;
  url?: string;
  config?: Record<string, any>;
  apiKey?: string;
  model?: string | any;
  modelProperties?: Record<string, any>;
}

export interface MemoryConfig {
  version?: string;
  embedder: {
    provider: string;
    config: EmbeddingConfig;
  };
  vectorStore: {
    provider: string;
    config: VectorStoreConfig;
  };
  llm: {
    provider: string;
    config: LLMConfig;
  };
  historyStore?: HistoryStoreConfig;
  disableHistory?: boolean;
  historyDbPath?: string;
  customInstructions?: string;
}

export interface MemoryItem {
  id: string;
  memory: string;
  hash?: string;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
  metadata?: Record<string, any>;
}

export interface SearchFilters {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  [key: string]: any;
}

export interface SearchResult {
  results: MemoryItem[];
}

export interface VectorStoreResult {
  id: string;
  payload: Record<string, any>;
  score?: number;
}

export const MemoryConfigSchema = z.object({
  version: z.string().optional(),
  embedder: z.object({
    provider: z.string(),
    config: z.object({
      modelProperties: z.record(z.string(), z.any()).optional(),
      apiKey: z.string().optional(),
      model: z.union([z.string(), z.any()]).optional(),
      baseURL: z.string().optional(),
      embeddingDims: z.number().optional(),
      url: z.string().optional(),
    }),
  }),
  vectorStore: z.object({
    provider: z.string(),
    config: z
      .object({
        collectionName: z.string().optional(),
        dimension: z.number().optional(),
        dbPath: z.string().optional(),
        client: z.any().optional(),
      })
      .passthrough(),
  }),
  llm: z.object({
    provider: z.string(),
    config: z.object({
      apiKey: z.string().optional(),
      model: z.union([z.string(), z.any()]).optional(),
      modelProperties: z.record(z.string(), z.any()).optional(),
      baseURL: z.string().optional(),
      url: z.string().optional(),
    }),
  }),
  historyDbPath: z.string().optional(),
  customInstructions: z.string().optional(),
  historyStore: z
    .discriminatedUnion("provider", [
      z.object({
        provider: z.literal("sqlite"),
        config: z.object({
          historyDbPath: z.string().optional(),
        }),
      }),
      z.object({
        provider: z.literal("supabase"),
        config: z.object({
          supabaseUrl: z.string(),
          supabaseKey: z.string(),
          tableName: z.string().optional(),
        }),
      }),
      z.object({
        provider: z.literal("postgres"),
        config: z.union([
          z.object({
            connectionString: z.string(),
            schema: z.string().optional(),
            tableName: z.string().optional(),
            messagesTableName: z.string().optional(),
            ssl: z.any().optional(),
          }),
          z
            .object({
              host: z.string(),
              port: z.number().optional(),
              user: z.string(),
              password: z.string().optional(),
              database: z.string().optional(),
              dbname: z.string().optional(),
              schema: z.string().optional(),
              tableName: z.string().optional(),
              messagesTableName: z.string().optional(),
              ssl: z.any().optional(),
            })
            .refine((value) => value.database || value.dbname, {
              message:
                "Postgres history store requires either database or dbname when using host/user config",
            }),
        ]),
      }),
      z.object({
        provider: z.literal("memory"),
        config: z.object({}),
      }),
    ])
    .optional(),
  disableHistory: z.boolean().optional(),
});
