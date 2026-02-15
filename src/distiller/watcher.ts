/**
 * Background file watcher for session directories.
 *
 * Uses polling to detect new session files across all configured platforms.
 * When a new session is detected, triggers the scoring + chunking pipeline.
 * Designed for integration into the REPL event loop.
 */

import { stat } from "node:fs/promises";
import { scanSessions, type ScanOptions } from "../scanner/scanner.ts";
import type { ScannedSession } from "../scanner/paths.ts";

export interface WatcherCallbacks {
  /** Called when a new session file is detected. */
  onNewSession: (session: ScannedSession) => void | Promise<void>;
  /** Called when an error occurs during scanning. */
  onError?: (error: Error) => void;
}

export interface WatcherConfig {
  /** Polling interval in milliseconds. Default: 5000 (5 seconds). */
  intervalMs: number;
  /** Scan options passed to the scanner. */
  scanOptions?: ScanOptions;
}

const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  intervalMs: 5000,
};

export class SessionWatcher {
  private config: WatcherConfig;
  private callbacks: WatcherCallbacks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownFiles = new Set<string>();
  private running = false;

  constructor(callbacks: WatcherCallbacks, config?: Partial<WatcherConfig>) {
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  /** Whether the watcher is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Start watching session directories. Seeds the known-files set on first run. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Seed known files with current state
    try {
      const existing = await scanSessions(this.config.scanOptions);
      for (const session of existing) {
        this.knownFiles.add(session.filePath);
      }
    } catch {
      // Ignore initial scan errors — directories may not exist yet
    }

    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.intervalMs);
  }

  /** Stop watching. Clears the polling interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /** Reset known files and clear state. */
  reset(): void {
    this.knownFiles.clear();
  }

  /** Number of files currently being tracked. */
  get trackedCount(): number {
    return this.knownFiles.size;
  }

  /** Single poll iteration — scans for new sessions. */
  private async poll(): Promise<void> {
    try {
      const sessions = await scanSessions(this.config.scanOptions);

      for (const session of sessions) {
        if (!this.knownFiles.has(session.filePath)) {
          this.knownFiles.add(session.filePath);
          try {
            await this.callbacks.onNewSession(session);
          } catch (err) {
            this.callbacks.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      }
    } catch (err) {
      this.callbacks.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
