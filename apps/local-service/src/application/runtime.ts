import { createInMemoryRepositories } from "../repositories/in-memory.js";
import type { LocalServiceRepositories } from "../repositories/contracts.js";

export type LocalServiceStorageMode = "memory" | "sqlite";

export type LocalServiceStorageInfo =
  | {
      mode: "memory";
      fallbackFrom?: "sqlite";
      reason?: string;
    }
  | {
      mode: "sqlite";
      databaseFilePath: string;
    };

export type LocalServiceRuntime = {
  repositories: LocalServiceRepositories;
  storage: LocalServiceStorageInfo;
};

type SqliteModule = typeof import("../repositories/sqlite.js");

const resolveRequestedStorageMode = (): LocalServiceStorageMode => {
  const configuredMode = process.env.APP_STORAGE_MODE?.trim().toLowerCase();

  if (configuredMode === "memory") {
    return "memory";
  }

  return "sqlite";
};

const loadSqliteModule = async (): Promise<SqliteModule> =>
  import("../repositories/sqlite.js");

export const createLocalServiceRuntime = async (): Promise<LocalServiceRuntime> => {
  const requestedMode = resolveRequestedStorageMode();

  if (requestedMode === "memory") {
    return {
      repositories: createInMemoryRepositories(),
      storage: {
        mode: "memory",
        reason: "APP_STORAGE_MODE=memory",
      },
    };
  }

  try {
    const {
      createSqliteRepositories,
      resolveLocalServiceDatabaseFilePath,
    } = await loadSqliteModule();
    const databaseFilePath = resolveLocalServiceDatabaseFilePath();

    return {
      repositories: createSqliteRepositories({
        databaseFilePath,
      }),
      storage: {
        mode: "sqlite",
        databaseFilePath,
      },
    };
  } catch (error) {
    if (process.env.APP_STORAGE_MODE?.trim().toLowerCase() === "sqlite") {
      throw error;
    }

    const reason =
      error instanceof Error ? error.message : "Unknown sqlite initialization failure.";

    // SQLite is the default path, but dev environments still need a usable fallback.
    // When callers explicitly require sqlite, the branch above keeps the failure visible.
    return {
      repositories: createInMemoryRepositories(),
      storage: {
        mode: "memory",
        fallbackFrom: "sqlite",
        reason,
      },
    };
  }
};
