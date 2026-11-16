import type { ConfigBackend } from "../core/config-backend.ts";
import type { JadeConfig } from "../core/config.ts";

const DEFAULT_CONFIG: JadeConfig = {
  version: "1.0",
  apps: [],
};

/**
 * Mock ConfigBackend that simulates jade.json reads/writes with in-memory state,
 * keyed by hub, instead of touching real disk.
 *
 * Usage in tests:
 *
 *   const { config } = createMockConfigBackend();
 *   const cmd = makeAddCommand(git, fs, config);
 *   await cmd.run!({ args: { ... } } as any);
 *   expect(getState("/path/to/workspace")).toBeDefined();
 */
export interface MockConfigBackend {
  config: ConfigBackend;
  /** Get in-memory config for a hub (returns undefined if never read/written) */
  getState(hub: string): JadeConfig | undefined;
  /** Pre-seed config for a hub (useful for tests that expect an existing jade.json) */
  seedState(hub: string, config: Partial<JadeConfig>): void;
  /** Calls recorded on the backend (for assertion purposes) */
  calls: { method: string; args: unknown[] }[];
}

export function createMockConfigBackend(): MockConfigBackend {
  const states = new Map<string, JadeConfig>();
  const calls: { method: string; args: unknown[] }[] = [];

  function record(method: string, ...args: unknown[]) {
    calls.push({ method, args });
  }

  const config: ConfigBackend = {
    /**
     * Return the in-memory config for this hub, or the same
     * defaults readConfig() falls back to when no jade.json exists yet.
     */
    async readConfig(hub: string): Promise<JadeConfig> {
      record("readConfig", hub);
      const existing = states.get(hub);
      return existing ? { ...existing } : { ...DEFAULT_CONFIG };
    },

    /**
     * Merge the patch into the existing (or default) config and store it,
     * matching core/config.ts's writeConfig merge semantics exactly.
     */
    async writeConfig(hub: string, patch: Partial<JadeConfig>): Promise<void> {
      record("writeConfig", hub, patch);
      const existing = states.get(hub) ?? { ...DEFAULT_CONFIG };
      states.set(hub, { ...existing, ...patch });
    },
  };

  return {
    config,
    getState: (hub) => states.get(hub),
    seedState(hub, overrides = {}) {
      states.set(hub, { ...DEFAULT_CONFIG, ...overrides });
    },
    calls,
  };
}
