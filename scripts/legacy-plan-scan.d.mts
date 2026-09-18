/** Types for the read-only legacy plan scanner. */

export interface LegacyPlanEntry {
  readonly file: string
  readonly planId: string
  readonly rootSessionId: string
  readonly childId: string
  readonly title?: string
}

export interface LegacyScanReport {
  readonly scannedFiles: number
  readonly corruptFiles: readonly string[]
  readonly terminal: readonly LegacyPlanEntry[]
  readonly nonterminal: readonly LegacyPlanEntry[]
}

export declare function decodeSessionLog(path: string): string
export declare function latestPlans(text: string): Map<string, Record<string, unknown>>
export declare function classifyPlan(plan: Record<string, unknown>): { legacy: boolean; terminal: boolean }
export declare function scanLegacyPlans(input: { sessionsRoot: string }): LegacyScanReport
export declare function legacyRemediation(report: LegacyScanReport): string[]
