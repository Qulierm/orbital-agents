/**
 * Tagged style injection for the composer dock.
 *
 * The client artifact builder emits one classic ModuleLoader script and no CSS
 * asset, so styles travel as a single tagged <style> element created at plugin
 * mount and removed by the plugin's effect disposer. The stylesheet adapts the
 * proven native calculations from QueueDock/InputBar/TodoPanel and every rule
 * is scoped under a unique `dsh-endeavour-` prefix.
 */

/** Stable style element id; at most one exists per document. */
export const STYLE_ELEMENT_ID = 'dsh-endeavour-styles'

/** Class names shared by the presentation and its tests. */
export const CLASS = {
  dockWrap: 'dsh-endeavour-dock-wrap',
  dockPanel: 'dsh-endeavour-dock-panel',
  peerReturnRow: 'dsh-endeavour-peer-return',
  card: 'dsh-endeavour-card',
  header: 'dsh-endeavour-header',
  title: 'dsh-endeavour-title',
  progress: 'dsh-endeavour-progress',
  routeHint: 'dsh-endeavour-route',
  roleLabel: 'dsh-endeavour-role-label',
  builderTrigger: 'dsh-endeavour-builder-trigger',
  builderModel: 'dsh-endeavour-builder-model',
  builderEffort: 'dsh-endeavour-builder-effort',
  builderSaving: 'dsh-endeavour-builder-saving',
  builderChevron: 'dsh-endeavour-builder-chevron',
  endeavourRole: 'dsh-endeavour-endeavour-role',
  menu: 'dsh-endeavour-menu',
  menuCell: 'dsh-endeavour-menu-cell',
  menuCellActive: 'dsh-endeavour-menu-cell dsh-endeavour-menu-cell--active',
  menuCellLabel: 'dsh-endeavour-menu-cell-label',
  menuCellValue: 'dsh-endeavour-menu-cell-value',
  menuCellChevron: 'dsh-endeavour-menu-cell-chevron',
  menuOption: 'dsh-endeavour-menu-option',
  menuOptionActive: 'dsh-endeavour-menu-option dsh-endeavour-menu-option--active',
  menuOptionCopy: 'dsh-endeavour-menu-option-copy',
  menuOptionName: 'dsh-endeavour-menu-option-name',
  menuCheck: 'dsh-endeavour-menu-check',
  menuGroup: 'dsh-endeavour-menu-group',
  menuNote: 'dsh-endeavour-menu-note',
  menuRetry: 'dsh-endeavour-menu-retry',
  menuError: 'dsh-endeavour-menu-error',
  ghost: 'dsh-endeavour-ghost',
  chevron: 'dsh-endeavour-chevron',
  rows: 'dsh-endeavour-rows',
  row: 'dsh-endeavour-row',
  rowRunning: 'dsh-endeavour-row--running',
  rowTitle: 'dsh-endeavour-row-title',
  rowStatus: 'dsh-endeavour-row-status',
  rowTimer: 'dsh-endeavour-row-timer',
  note: 'dsh-endeavour-note',
  glyph: 'dsh-endeavour-glyph',
  glyphRunning: 'dsh-endeavour-glyph--running',
  glyphSucceeded: 'dsh-endeavour-glyph--succeeded',
  glyphFailed: 'dsh-endeavour-glyph--failed',
  glyphFinished: 'dsh-endeavour-glyph--finished',
  glyphPending: 'dsh-endeavour-glyph--pending',
  pulse: 'dsh-endeavour-pulse',
  builderControl: 'dsh-endeavour-builder-control',
} as const

/**
 * Stylesheet text. Width math and the attached-top-surface treatment follow
 * QueueDock.module.css; tokens are the current `--dsw-alias-*` family plus the
 * composer variables published by ConversationRoot.
 */
export const STYLE_TEXT = `
/* Same outer width axis as InputBar: side clearance only, no dock inset, so
   the computed width equals the composer card exactly. */
.dsh-endeavour-dock-wrap {
  box-sizing: border-box;
  position: relative;
  flex: none;
  width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));
  max-width: var(--dsh-composer-card-max-width);
  margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
  padding: 0;
}
/* Same surface, stroke, radius, and elevation family as the InputBar card, with
   a square bottom so the input card's own top edge closes the attached shape. */
.dsh-endeavour-dock-panel {
  position: relative;
  overflow: hidden;
  width: 100%;
  padding: 1px 0 1px;
  border-radius: 22px 22px 0 0;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
/* Connected mode (only while our dock is mounted in the same composer seat):
   the composer card drops its own elevation and squares its top corners, so the
   lower half has the same borderless edge as the dock. The dock overlaps the
   card top by ~3px, which is now the only thing closing the shape: no stroke,
   no soft-shadow rim, and no junction pseudo-element that could produce
   subpixel edge artifacts. Normal composers keep their native elevation. */
[data-composer-seat]:has(.dsh-endeavour-dock-wrap) [data-composer-card] {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  box-shadow: none;
}

.dsh-endeavour-card {
  box-sizing: border-box;
  width: 100%;
  max-width: 560px;
  padding: 6px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-primary);
}
.dsh-endeavour-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 2px 12px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 24px;
}
.dsh-endeavour-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Native ModelSelect trigger contract: 28px chip, 13/20 medium secondary
   label, 4px gap, caption effort. The role label shares the same 28px row. */
.dsh-endeavour-builder-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
}
.dsh-endeavour-role-label {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 6px;
  border-radius: 8px 0 0 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  flex: none;
}
.dsh-endeavour-builder-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: min(300px, 45cqw);
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: 0 8px 8px 0;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
  flex: 0 1 auto;
}
.dsh-endeavour-builder-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-endeavour-builder-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.dsh-endeavour-builder-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-endeavour-builder-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-endeavour-builder-effort {
  flex-shrink: 1000;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption);
}
.dsh-endeavour-builder-saving { flex: none; color: var(--dsw-alias-label-caption); font-size: 12px; }
.dsh-endeavour-builder-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); }
/* Endeavour role: last right-side entry, joined to the native model trigger. */
.dsh-endeavour-endeavour-role {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 6px;
  border-radius: 8px 0 0 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  flex: none;
}
[data-composer-card]:has([data-endeavour-role="endeavour"]) [data-slot="conversation.input.model"] button {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  padding-left: 6px;
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
}
[data-composer-card]:has([data-endeavour-role="endeavour"]) [data-slot="conversation.input.model"] button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* One toolbar line: disable native wrapping and let the designated items
   shrink instead (stable anchors: data-input-scroll marks the input area, so
   its next sibling is the native tools/trailing row). */
[data-composer-card] [data-input-scroll] + div {
  flex-wrap: nowrap;
  gap: 8px;
  min-width: 0;
}
[data-composer-card] [data-input-scroll] + div > :last-child {
  flex-shrink: 1;
  min-width: 0;
}
/* Left-side controls (workspace, access select, plan) keep their own space;
   only their text may ellipsize, never reorder. */
[data-composer-card] :has(> [data-slot="conversation.input.left"]) > div {
  min-width: 0;
  overflow: hidden;
}
/* Speed (order 10) and limits (order 20) are native right-slot entries ahead
   of the two role groups; CSS never reorders them and they keep their size. */
[data-composer-card] [data-slot="conversation.input.right"] > * { order: 0; }
[data-composer-card] [data-slot="conversation.input.model"] > div {
  min-width: 0;
  flex-shrink: 1;
  margin-right: 2px;
}
/* Tighter gaps only when both role groups are present. */
[data-composer-card]:has([data-endeavour-role]) :has(> [data-slot="conversation.input.left"]) { gap: 8px; min-width: 0; }
[data-composer-card]:has([data-endeavour-role]) :has(> [data-slot="conversation.input.right"]) { gap: 8px; min-width: 0; }
/* Shrink priority 1: effort captions collapse below the normal card width;
   the compact Builder trigger sheds its caption a little earlier so it never
   degrades to a single letter while the native trigger keeps its own. */
@media (max-width: 1500px) {
  .dsh-endeavour-builder-effort { display: none; }
}
@media (max-width: 1440px) {
  [data-composer-card]:has([data-endeavour-role="endeavour"]) [data-slot="conversation.input.model"] button span:nth-of-type(2) { display: none; }
}
/* Shrink priority 2: long model names ellipsize hard at the narrow breakpoint. */
@media (max-width: 1024px) {
  [data-composer-card]:has([data-endeavour-role="endeavour"]) [data-slot="conversation.input.model"] button { max-width: 120px; }
}
/* Shrink priority 3: role labels shorten to B/E at the documented narrow
   breakpoint, keeping the exact 13/20/500 role typography. */
@media (max-width: 1360px) {
  .dsh-endeavour-role-label, .dsh-endeavour-endeavour-role { font-size: 0; padding: 0 6px; }
  .dsh-endeavour-role-label::after, .dsh-endeavour-endeavour-role::after { font-size: 13px; line-height: 20px; font-weight: 500; }
  .dsh-endeavour-role-label::after { content: 'B'; }
  .dsh-endeavour-endeavour-role::after { content: 'E'; }
}
/* Native ModelSelect menu card: portaled, radius 20, specific-menu surface,
   prominent elevation, 40px root cells, 14/22 typography. */
.dsh-endeavour-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: min(240px, calc(100vw - 32px));
  max-width: min(420px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 96px));
  overflow-y: auto;
  padding: 4px;
  border: 0;
  border-radius: 20px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-endeavour-menu-cell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 100%;
  height: 40px;
  padding: 0 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  text-align: left;
}
.dsh-endeavour-menu-cell:hover:not(:disabled), .dsh-endeavour-menu-cell--active { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-endeavour-menu-cell:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-endeavour-menu-cell-label { flex: 0 0 auto; white-space: nowrap; }
.dsh-endeavour-menu-cell-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-endeavour-menu-cell-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.dsh-endeavour-menu-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 100%;
  min-height: 38px;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  outline: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-endeavour-menu-option:hover:not(:disabled), .dsh-endeavour-menu-option--active { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-endeavour-menu-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-endeavour-menu-option-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.dsh-endeavour-menu-option-name {
  overflow: hidden;
  color: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-endeavour-menu-check { display: grid; place-items: center; flex: 0 0 18px; color: var(--dsw-alias-label-primary); }
.dsh-endeavour-menu-group {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 5px 8px 3px;
  background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.dsh-endeavour-menu-note { display: flex; gap: 8px; align-items: center; padding: 10px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dsh-endeavour-menu-retry { flex: 0 0 auto; padding: 0; border: none; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.dsh-endeavour-menu-error { padding: 7px 8px; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dsh-endeavour-route {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.dsh-endeavour-progress {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-endeavour-chevron {
  flex: none;
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: grid;
  place-items: center;
}
.dsh-endeavour-chevron:focus-visible,
.dsh-endeavour-ghost:focus-visible {
  outline: 2px solid var(--dsw-alias-label-tertiary);
  outline-offset: -2px;
}
.dsh-endeavour-peer-return {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 2px 2px 0;
}

.dsh-endeavour-ghost {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-endeavour-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-endeavour-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0 12px;
  list-style: none;
  max-height: 160px;
  overflow-y: auto;
}
.dsh-endeavour-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 27px;
  padding: 0 6px;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  transition: background-color 160ms ease-out, color 160ms ease-out;
}
.dsh-endeavour-row--running {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-endeavour-row-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-endeavour-row-status {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-endeavour-row-timer {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dsh-endeavour-glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
}
.dsh-endeavour-glyph--pending { color: var(--dsw-alias-label-caption); }
.dsh-endeavour-glyph--running {
  color: var(--dsw-alias-state-business-primary);
  animation: dsh-endeavour-spin 1s linear infinite;
}
.dsh-endeavour-glyph--finished { color: var(--dsw-alias-label-secondary); }
.dsh-endeavour-glyph--succeeded { color: var(--dsw-alias-state-success-primary); }
.dsh-endeavour-glyph--failed { color: var(--dsw-alias-state-error-primary); }
.dsh-endeavour-pulse {
  animation: dsh-endeavour-pulse 1.6s ease-in-out infinite;
}
.dsh-endeavour-note {
  padding: 0 12px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes dsh-endeavour-spin {
  to { transform: rotate(360deg); }
}
@keyframes dsh-endeavour-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-endeavour-glyph--running,
  .dsh-endeavour-pulse {
    animation: none;
  }
  .dsh-endeavour-row {
    transition: none;
  }
}
`

/**
 * Create or refresh the tagged stylesheet.
 * @returns disposer that removes the element this call created.
 */
export function ensurePlanStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  let element = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  let created = false
  if (element === null) {
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.setAttribute('data-dsh-endeavour', 'styles')
    document.head.appendChild(style)
    element = style
    created = true
  }
  if (element.textContent !== STYLE_TEXT) element.textContent = STYLE_TEXT
  const owned: HTMLStyleElement = element
  return () => {
    if (created) owned.remove()
  }
}
