/**
 * Blank-peer return fallback for the composer dock.
 *
 * rc.2 renders the native View ring only once a session has content: a freshly
 * provisioned Challenger has no turns, so its `Chat/Trajectory/Endeavour` strip
 * does not exist yet and there would be no way back to the Endeavour session
 * from inside the peer. This entry is the official fallback — a restrained
 * native-styled button that opens the EXACT paired Endeavour session through
 * the same `ISessions.open` bridge the peer tab uses.
 *
 * It renders ONLY while the current session is the Challenger side of a valid
 * pair AND the shared dock offers no usable return action: either no plan is
 * projected at all, or the projected plan is a historical `childId`-only card
 * whose action is deliberately disabled. A canonical peer plan hides this entry
 * because the shared dock's role-aware `Open Endeavour` action is then the
 * return path (exactly one affordance). It is a pure client-side surface: no
 * DOM injection, no synthetic events, no prompt, no durable write.
 */

import { useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EndeavourCardData } from '../plan-projection.js'
import { copyFrom, type EndeavourInjected } from './PlanCard.js'
import { planAction } from './plan-action.js'
import { CLASS } from './styles.js'

/** Complete dock renderer props (session scope supplies the injection). */
export type PeerReturnDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

const noopSubscribe = (): (() => void) => () => undefined
const noopSnapshot = (): null => null

/** Fallback return entry; renders nothing outside a blank paired Challenger. */
export function PeerReturnDock(props: PeerReturnDockProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const peerReturn = props.peerReturn
  const peer = useSyncExternalStore(
    peerReturn?.subscribe ?? noopSubscribe,
    peerReturn?.getSnapshot ?? noopSnapshot,
    peerReturn?.getSnapshot ?? noopSnapshot,
  )
  const source = props.planSource
  const plan = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.getSnapshot ?? noopSnapshot,
    source?.getSnapshot ?? noopSnapshot,
  )
  // Only the paired Challenger side, and only while the shared dock cannot
  // navigate (nothing projected, or a legacy card whose action is disabled).
  if (peer === null) return null
  if (plan !== null && planAction(plan as EndeavourCardData, props.currentSessionId).kind === 'peer') return null
  const target = peer.counterpartId
  return (
    <div className={CLASS.dockWrap}>
      <div className={CLASS.peerReturnRow}>
        <button
          type="button"
          className={CLASS.ghost}
          aria-label={copy('peer.returnTitle')}
          title={copy('peer.returnTitle')}
          onClick={() => { props.openCounterpart(target) }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {copy('peer.return')}
        </button>
      </div>
    </div>
  )
}

/** Stable id/order: the fallback sits just above the plan dock in the same slot. */
export const PEER_RETURN_DOCK_ID = 'endeavour-peer-return'
export const PEER_RETURN_DOCK_ORDER = 999

/** Registers the fallback with the shared injected navigation. */
export function registerPeerReturnDock(slots: {
  inject(name: string, callback: () => void): void
  register(options: { name: string; id: string; order: number; locale: string; inject?: () => unknown }, component: unknown): void
}, injectProps: () => EndeavourInjected): void {
  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: PEER_RETURN_DOCK_ID, order: PEER_RETURN_DOCK_ORDER, locale: 'endeavour', inject: injectProps },
    PeerReturnDock as unknown as (props: PeerReturnDockProps) => unknown,
  ))
}
