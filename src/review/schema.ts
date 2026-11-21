/**
 * The review the orchestrator submits for a task, as a zod schema. The reviewer grades every acceptance
 * criterion with evidence and lists findings with a severity; code, not the reviewer, decides whether that
 * is good enough to accept (state.ts).
 */

import { z } from 'zod';

export const CRITERION_VERDICTS = ['pass', 'fail', 'unknown'] as const;
export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export const REVIEW_VERDICTS = ['accept', 'revise', 'reject'] as const;

export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const ReviewSchema = z
  .object({
    verdict: z.enum(REVIEW_VERDICTS),
    criteria: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(2_000),
            verdict: z.enum(CRITERION_VERDICTS),
            evidence: z.string().min(1).max(4_000),
          })
          .strict(),
      )
      .max(50),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(SEVERITIES),
            summary: z.string().min(1).max(500),
            path: z.string().min(1).max(1_000).optional(),
            detail: z.string().max(10_000).optional(),
          })
          .strict(),
      )
      .max(100),
    /** What the worker should change, for a "revise" verdict. */
    instructions: z.string().max(20_000).optional(),
  })
  .strict();

export type Review = z.infer<typeof ReviewSchema>;
