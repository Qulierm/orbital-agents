/** Type surface for the offline session-marker repair tool. */

export const EVENT_TYPE: string
export const MARKER_TEXT: string
export function desktopRunning(): boolean
export function markLine(line: string): string | null
export interface RepairResult {
  readonly results: readonly { readonly file: string; readonly changed: number; readonly written?: boolean; readonly backupPath?: string }[]
  readonly totals: {
    readonly files: number
    readonly repairedFiles: number
    readonly repairedRows: number
    readonly written: boolean
    readonly backupDir: string | null
  }
}
export function repairSessionEvents(options?: {
  sessionsRoot?: string
  backupRoot?: string
  backupDir?: string
  write?: boolean
  force?: boolean
  isRunning?: () => boolean
}): RepairResult
