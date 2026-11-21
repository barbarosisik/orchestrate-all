/** Every engine's adapter, by the engine name the plan uses. */

import type { EngineName } from '../plan/schema.js';
import type { EngineAdapter } from './adapter.js';
import { antigravityAdapter } from './antigravity.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

export const ADAPTERS: Readonly<Record<EngineName, EngineAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
};
