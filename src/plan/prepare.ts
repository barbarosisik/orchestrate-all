/** The full "is this plan ready to approve?" check: plan rules first, then the real repository. */

import { checkRepo, type RepoCheckResult, type RepoOptions } from '../repo/checks.js';
import { validatePlan, type ValidationContext } from './validate.js';

export async function preparePlan(input: unknown, ctx: ValidationContext, repo: RepoOptions): Promise<RepoCheckResult> {
  const validated = validatePlan(input, ctx);
  if (!validated.ok) return validated;
  return checkRepo(validated.plan, repo);
}
