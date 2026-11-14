/**
 * Bun test preload — runs once before all test files.
 *
 * Silences console output so test runs stay readable.
 * Tests that need to assert on console output can override console.log
 * locally within the test (the existing pattern in this codebase), and
 * restoring to the no-op is harmless.
 *
 * Also turns off JSON mode before every test: a command run with --json
 * leaves it on for the rest of the process, which in the CLI is one command
 * but here is every test after it.
 */
import { beforeEach } from "bun:test";
import { setJsonMode } from "../adapters/ui.ts";

const noop = () => {};
console.log = noop;
console.error = noop;
console.warn = noop;

beforeEach(() => setJsonMode(false));
