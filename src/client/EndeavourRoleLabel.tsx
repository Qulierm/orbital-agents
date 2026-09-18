/**
 * Endeavour role label for the composer tool row.
 *
 * A static, non-interactive segment rendered as the LAST entry of
 * `conversation.input.right` (order 1000, after the cost meter at order 5), so
 * it sits immediately before the native `conversation.input.model` seat and can
 * visually join it into one `[Endeavour | model · effort ▼]` segmented control
 * through scoped CSS. It never touches the native ModelSelect: the dropdown
 * stays fully clickable, focusable, and behaviorally unchanged. Visible only in
 * Endeavour root sessions; Standard chats and addressed Builder children render
 * nothing.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { copyFrom } from './PlanCard.js'
import { CLASS } from './styles.js'

export type EndeavourRoleLabelProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'endeavour'>

export function EndeavourRoleLabel(props: EndeavourRoleLabelProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const useSession = (props as { readonly useSession?: (selector: (state: unknown) => unknown) => unknown }).useSession
  const agentPreset = typeof useProjection === 'function' ? (useProjection('agentPreset') as string | undefined) : undefined
  const sessionState = typeof useSession === 'function'
    ? (useSession((state: unknown) => state) as { readonly subagent?: unknown } | undefined)
    : undefined
  const addressedChild = sessionState?.subagent !== undefined && sessionState?.subagent !== null
  if (agentPreset !== 'endeavour' || addressedChild) return null
  return (
    <span
      className={CLASS.endeavourRole}
      data-endeavour-role="endeavour"
      title={copy('role.endeavourTitle')}
      aria-hidden="true"
    >
      {copy('role.endeavour')}
    </span>
  )
}
