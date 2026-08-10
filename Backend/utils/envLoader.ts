import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

/**
 * Priority order for environment loading:
 * 1. .env.local (Highest priority for local overrides)
 * 2. .env (Default environment variables)
 * 3. System process.env (Retained unless overridden)
 */
export function loadEnvironment(): void {
  const rootDir = process.cwd();
  const envLocalPath = path.resolve(rootDir, '.env.local');
  const envPath = path.resolve(rootDir, '.env');

  // Load .env first if present
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
    console.log(`[EnvLoader] Loaded base environment from ${envPath}`);
  }

  // Load .env.local on top of .env if present (overrides .env)
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
    console.log(`[EnvLoader] Overrode environment with local settings from ${envLocalPath}`);
  }
}

/**
 * Reactive Environment File Watcher
 * Watches .env and .env.local for file changes during runtime and updates process.env dynamically.
 */
export function watchEnvironmentChanges(onReload?: () => void): void {
  const rootDir = process.cwd();
  const filesToWatch = ['.env', '.env.local'];

  filesToWatch.forEach((fileName) => {
    const filePath = path.resolve(rootDir, fileName);
    if (fs.existsSync(filePath)) {
      let debounceTimeout: NodeJS.Timeout | null = null;
      fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          if (debounceTimeout) clearTimeout(debounceTimeout);
          debounceTimeout = setTimeout(() => {
            console.log(`⚡ [EnvWatcher] Detected change in ${fileName}. Reloading environment variables...`);
            loadEnvironment();
            if (onReload) onReload();
          }, 300);
        }
      });
      console.log(`[EnvWatcher] Watching ${fileName} for live environment changes.`);
    }
  });
}
