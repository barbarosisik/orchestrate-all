/** The plan an orchestrator submits, as a zod schema. Shape checks only; rules live in validate.ts. */

import { z } from 'zod';

export const ENGINE_NAMES = ['claude', 'codex', 'antigravity'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Engines that can be the orchestrator (front door). */
export const ORCHESTRATOR_ENGINES = ['claude', 'codex'] as const;

export const TASK_ID_PATTERN = /^[a-z0-9-]{1,16}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const ModelSchema = z.string().regex(MODEL_PATTERN, 'Model names may use letters, digits and . _ : - (1-64 chars).');

export const TaskSchema = z
  .object({
    id: z.string().regex(TASK_ID_PATTERN, 'Task ids use a-z, 0-9 and "-" (1-16 chars).'),
    title: z.string().min(1).max(80),
    kind: z.enum(['work', 'reserved']),
    mode: z.enum(['write', 'readonly']),
    brief: z.string().min(1).max(100_000),
    engine: z.enum(ENGINE_NAMES),
    model: ModelSchema,
    owns: z.array(z.string()).max(200),
    dependsOn: z.array(z.string()).max(32),
    acceptance: z
      .object({
        commands: z.array(z.array(z.string().min(1)).min(1)).max(20),
        criteria: z.array(z.string().min(1)).max(50),
      })
      .strict(),
  })
  .strict();

export const PlanSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().min(1).max(10_000),
    repo: z.string().min(1).max(1024),
    targetBranch: z.string().max(1024),
    /** Accepted for convenience but always discarded: the conductor fills it from the target branch. */
    baseSha: z.string().optional(),
    orchestrator: z.object({ engine: z.enum(ORCHESTRATOR_ENGINES), model: ModelSchema }).strict(),
    tasks: z.array(TaskSchema).min(1).max(100),
  })
  .strict();

export type Task = z.infer<typeof TaskSchema>;
export type PlanInput = z.infer<typeof PlanSchema>;
