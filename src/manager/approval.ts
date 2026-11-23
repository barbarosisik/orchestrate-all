/**
 * Approval (R5): starting a run, finalizing it and discarding it each need the user's own yes. No model and no HTTP
 * call can give it. The run manager only asks, through an Approver; step 13 provides the real one, a native dialog
 * the conductor shows. Until then the service uses NO_APPROVER, which refuses everything, so nothing can start.
 *
 * An answer counts only for the exact request it answers: it must name the same plan hash, so a dialog shown for one
 * plan can't approve another. Anything else (a refusal, an error, a different hash) is a no.
 */

export type ApprovalKind = 'start' | 'finalize' | 'discard';

export interface ApprovalRequest {
  readonly kind: ApprovalKind;
  readonly runId: string;
  /** The approved plan's hash: what the answer must name. */
  readonly planHash: string;
  /** Plain text for the dialog: the routing table, rule files and warnings, the finalize report, or what goes. */
  readonly text: string;
}

export type ApprovalAnswer = { readonly approved: true; readonly planHash: string } | { readonly approved: false; readonly reason: string };

export interface Approver {
  /** Asks the user. May take as long as the user does; `signal` aborts when the request is no longer needed. */
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>;
}

/** Refuses everything: there is no way to approve before the dialog (step 13) exists. */
export const NO_APPROVER: Approver = {
  ask: () => Promise.resolve({ approved: false, reason: 'Approving needs the confirmation dialog, which is not built yet (step 13).' }),
};

/** Asks, and returns null when the answer approves exactly this request, or why not. Never throws. */
export async function askApproval(approver: Approver, request: ApprovalRequest, signal?: AbortSignal): Promise<string | null> {
  let answer: ApprovalAnswer;
  try {
    answer = await approver.ask(request, signal);
  } catch (error) {
    return `The approval could not be asked: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (answer === null || typeof answer !== 'object') return 'The approval gave no answer.';
  if (answer.approved !== true) return `Not approved: ${typeof answer.reason === 'string' && answer.reason.length > 0 ? answer.reason : 'no reason given'}.`;
  if (answer.planHash !== request.planHash) return 'The approval was for another plan.';
  return null;
}
