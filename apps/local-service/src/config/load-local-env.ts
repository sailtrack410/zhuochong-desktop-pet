import { resolve } from "node:path";

const envFileNames = [".env.local", ".env"];

export const loadLocalServiceEnv = () => {
  for (const fileName of envFileNames) {
    try {
      process.loadEnvFile(resolve(process.cwd(), fileName));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }

      // eslint-disable-next-line no-console
      console.warn(`[local-service] failed to load ${fileName}`, error);
    }
  }
};
