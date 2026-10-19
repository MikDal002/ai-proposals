import { beforeEach, vi } from "vitest";

/**
 * Global Vitest test setup executed before every test suite.
 * Clears all mock histories, active spies, and mock return values.
 */
beforeEach(() => {
  vi.clearAllMocks();
});
