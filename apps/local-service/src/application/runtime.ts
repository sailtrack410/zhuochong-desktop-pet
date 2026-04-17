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
  close: () => void;
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
      close: () => {},
    };
  }

  try {
    const {
      createSqliteRepositories,
      resolveLocalServiceDatabaseFilePath,
    } = await loadSqliteModule();
    const databaseFilePath = resolveLocalServiceDatabaseFilePath();
    const repos = createSqliteRepositories({
      databaseFilePath,
    });

    return {
      repositories: repos,
      storage: {
        mode: "sqlite",
        databaseFilePath,
      },
      close: () => repos.close(),
    };
  } catch (error) {
    if (process.env.APP_STORAGE_MODE?.trim().toLowerCase() === "sqlite") {
      throw error;
    }

    const reason =
      error instanceof Error ? error.message : "Unknown sqlite initialization failure.";

    return {
      repositories: createInMemoryRepositories(),
      storage: {
        mode: "memory",
        fallbackFrom: "sqlite",
        reason,
      },
      close: () => {},
    };
  }
};
