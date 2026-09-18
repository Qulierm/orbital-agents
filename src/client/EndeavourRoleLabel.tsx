/**
 * Endeavour role label for the composer tool row.
 *
 * A static, non-interactive segment rendered as the LAST entry of
 * `conversation.input.right` (order 1000, after the cost meter at order 5), so
 * it sits immediately before the native `conversation.input.model` seat and can
 * visually join it into one `[Endeavour | model · effort ▼]` segmented control
 * through scoped CSS. It never touches the native ModelSelect: the dropdown
 * stays fully clickable, focusable, and behaviorally unchanged. Visible only on
 * the paired ENDEAVOUR side of a durable pair (its role comes from the
 * `endeavourPeer` projection), so Standard chats, the Challenger session and
 * unrelated subagent sessions render nothing.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { peerView } from '../peer-projection.js'
import { validatePeerState, type PeerState } from '../peer.js'
import { copyFrom } from './PlanCard.js'
import { CLASS } from './styles.js'

export type EndeavourRoleLabelProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'endeavour'>

export function EndeavourRoleLabel(props: EndeavourRoleLabelProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const agentPreset = typeof useProjection === 'function' ? (useProjection('agentPreset') as string | undefined) : undefined
  const peer = typeof useProjection === 'function' ? useProjection('endeavourPeer') : undefined
  const sessionId = (props as { readonly sessionId?: string }).sessionId
  // Peer-role visibility only: the label belongs to the Endeavour side.
  const state = (peer ?? null) as PeerState | null
  const role = state === null || validatePeerState(state).length > 0 || sessionId === undefined
    ? undefined
    : peerView(state, sessionId)?.role
  if (agentPreset !== 'endeavour' || role !== 'endeavour') return null
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
