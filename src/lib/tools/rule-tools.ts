import { z } from 'zod';
import { quarantine } from '../domain/injection';
import { compileRule, type QualityRule } from '../domain/rules';
import { addRule, isPersistenceAvailable, loadRules } from '../rules-store';
import { withGuards, type ToolContext } from './guards';
import { datasetIdJson, parseOrThrow } from './schemas';
import type { ToolDefinition, ToolFactory } from './types';

/**
 * Two tools, not four.
 *
 * Listing folds into `evaluate_quality_rules` (you almost always want the rules
 * *and* their current state together) and deletion is a UI affordance. Tool
 * count is not free — selection accuracy degrades as the surface grows — so a
 * tool has to earn its place rather than mirror a CRUD table.
 */

const RULE_TYPES = ['not_null', 'unique', 'regex', 'range', 'in_set'] as const;
const RULE_SEVERITIES = ['critical', 'warning', 'info'] as const;

const createRuleSchema = z.object({
  dataset_id: z.string().max(64),
  name: z.string().min(1).max(100),
  column: z.string().max(255),
  type: z.enum(RULE_TYPES),
  params: z
    .object({
      pattern: z.string().max(500).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      values: z.array(z.string().max(255)).max(200).optional(),
    })
    .default({}),
  severity: z.enum(RULE_SEVERITIES).default('warning'),
});

export const createQualityRule: ToolFactory = (getContext): ToolDefinition => ({
  name: 'create_quality_rule',
  description:
    'Define a reusable validation rule for a column and check it immediately. Types: not_null, ' +
    'unique, regex, range, in_set. Rules are saved in this browser only, not shared with a team. ' +
    'There is deliberately no free-form SQL rule type.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset_id: datasetIdJson,
      name: { type: 'string', minLength: 1, maxLength: 100 },
      column: { type: 'string', maxLength: 255 },
      type: { type: 'string', enum: [...RULE_TYPES] },
      params: {
        type: 'object',
        properties: {
          pattern: { type: 'string', maxLength: 500, description: 'For type regex (RE2 syntax).' },
          min: { type: 'number', description: 'For type range.' },
          max: { type: 'number', description: 'For type range.' },
          values: {
            type: 'array',
            maxItems: 200,
            items: { type: 'string', maxLength: 255 },
            description: 'For type in_set.',
          },
        },
        additionalProperties: false,
      },
      severity: { type: 'string', enum: [...RULE_SEVERITIES], default: 'warning' },
    },
    required: ['dataset_id', 'name', 'column', 'type'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  execute: withGuards(
    {
      name: 'create_quality_rule',
      // Creates a rule, but touches no dataset. Gating it behind a confirmation
      // would train users to click through the gate that guards real edits.
      mutating: false,
      rateLimitPerMinute: 20,
      validate: (input) => parseOrThrow(createRuleSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const head = ctx.registry.head(input.dataset_id);

        const rule: QualityRule = {
          id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          name: input.name,
          column: input.column,
          type: input.type,
          params: input.params,
          severity: input.severity,
          createdAt: new Date().toISOString(),
        };

        // Compile before saving: bad parameters should fail now, not silently
        // at the next evaluation when the user has moved on.
        const compiled = compileRule(rule, head.id, head.columns);
        const count = await ctx.engine.query(compiled.violationSql);
        const violations = Number(count.rows[0]?.['violations'] ?? 0);

        const persisted = addRule(rule);

        return {
          rule_id: rule.id,
          rule: {
            name: rule.name,
            column: rule.column,
            type: rule.type,
            severity: rule.severity,
            means: compiled.description,
          },
          violations_now: violations,
          violation_rate: head.rowCount === 0 ? 0 : violations / head.rowCount,
          persisted,
          ...(persisted
            ? {}
            : {
                note:
                  'The rule was checked but not saved — browser storage is unavailable (private ' +
                  'window, or site data blocked). It will not survive a reload.',
              }),
        };
      },
    },
    getContext,
  ),
});

const evaluateRulesSchema = z.object({ dataset_id: z.string().max(64) });

export const evaluateQualityRules: ToolFactory = (getContext): ToolDefinition => ({
  name: 'evaluate_quality_rules',
  description:
    'Run every saved quality rule against a dataset and report violations with example offending ' +
    'values. Rules that name a column this dataset lacks are reported as inapplicable rather ' +
    'than as passing. Also lists the rules, so this doubles as "show me my rules".',
  inputSchema: {
    type: 'object',
    properties: { dataset_id: datasetIdJson },
    required: ['dataset_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, untrustedContentHint: true },
  execute: withGuards(
    {
      name: 'evaluate_quality_rules',
      mutating: false,
      rateLimitPerMinute: 20,
      validate: (input) => parseOrThrow(evaluateRulesSchema, input),
      execute: async (input, ctx: ToolContext) => {
        const head = ctx.registry.head(input.dataset_id);
        const rules = loadRules();

        const results: Record<string, unknown>[] = [];

        for (const rule of rules) {
          // Reported as inapplicable, never as a pass: a rule that cannot run
          // must not contribute to an all-clear.
          if (!head.columns.includes(rule.column)) {
            results.push({
              rule_id: rule.id,
              name: rule.name,
              column: rule.column,
              severity: rule.severity,
              applicable: false,
              reason: `This dataset has no column "${rule.column}".`,
            });
            continue;
          }

          try {
            const compiled = compileRule(rule, head.id, head.columns);
            const count = await ctx.engine.query(compiled.violationSql);
            const violations = Number(count.rows[0]?.['violations'] ?? 0);
            const samples = violations > 0 ? await ctx.engine.query(compiled.sampleSql) : null;

            results.push({
              rule_id: rule.id,
              name: rule.name,
              column: rule.column,
              severity: rule.severity,
              applicable: true,
              description: compiled.description,
              violations,
              passed: violations === 0,
              examples: samples
                ? quarantine(samples.rows.map((r) => String(r['v'] ?? '')).join('\n'))
                : null,
            });
          } catch (error) {
            results.push({
              rule_id: rule.id,
              name: rule.name,
              column: rule.column,
              severity: rule.severity,
              applicable: false,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const applicable = results.filter((r) => r['applicable'] === true);
        const failing = applicable.filter((r) => r['passed'] === false);

        return {
          dataset_id: input.dataset_id,
          rules_total: rules.length,
          rules_applicable: applicable.length,
          rules_failing: failing.length,
          critical_failures: failing.filter((r) => r['severity'] === 'critical').length,
          results,
          storage: isPersistenceAvailable()
            ? 'Rules are saved in this browser only, not shared with a team.'
            : 'Browser storage is unavailable, so no rules are saved.',
        };
      },
    },
    getContext,
  ),
});

export const RULE_TOOLS: readonly ToolFactory[] = [createQualityRule, evaluateQualityRules];
