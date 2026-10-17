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
  roleGlyph: 'dsh-endeavour-role-glyph',
  challengerControl: 'dsh-endeavour-challenger-control',
  challengerTrigger: 'dsh-endeavour-challenger-trigger',
  challengerTriggerLabel: 'dsh-endeavour-challenger-trigger-label',
  challengerChevron: 'dsh-endeavour-challenger-chevron',
  challengerChevronOpen: 'dsh-endeavour-challenger-chevron dsh-endeavour-challenger-chevron--open',
  menu: 'dsh-endeavour-menu',
  menuMaterial: 'dsh-endeavour-menu-material',
  menuRows: 'dsh-endeavour-menu-rows',
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
  glyphInterrupted: 'dsh-endeavour-glyph--interrupted',
  pulse: 'dsh-endeavour-pulse',
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
/* The custom Challenger selector: a compact dropdown registered in the
   right-slot list beside the host's own Endeavour selector, which it never
   hides, restyles or replaces. Its metrics mirror the installed native
   ModelSelect button so the two read as siblings. */
.dsh-endeavour-role-glyph {
  display: block;
  flex: none;
  color: currentColor;
}
.dsh-endeavour-challenger-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  min-width: 0;
  flex: none;
}
/* Trigger geometry, type and states mirror the native ModelSelect button
   (height 28, 13/20 regular, 4px gap, 0 4px 0 8px padding, --dsw-radius-sm). */
.dsh-endeavour-challenger-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  min-width: 0;
  max-width: min(360px, 45cqw);
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  cursor: pointer;
}
.dsh-endeavour-challenger-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-endeavour-challenger-trigger:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dsh-endeavour-challenger-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-endeavour-challenger-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-endeavour-challenger-chevron { flex: none; color: var(--dsw-alias-label-caption); transition: transform 0.12s; }
.dsh-endeavour-challenger-chevron--open { transform: rotate(180deg); }
/* The custom root owns no toolbar geometry: the model-slot host lays out its
   own children, and the native selector next to this one is untouched. */
[data-composer-card] :has(> [data-slot="conversation.input.left"]) [data-slot="conversation.input.left"] > button,
[data-composer-card] :has(> [data-slot="conversation.input.left"]) [data-slot="conversation.input.left"] > div > button {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Native ModelSelect menu card: portaled, viewport-constrained 240-420px,
   4px padding, z-index 1100, --dsw-radius-lg and prominent elevation. The fill
   and blur live on a separate noninteractive material layer, so backdrop-filter
   never filters the rows themselves and never creates a containing block for
   nested overlays. */
.dsh-endeavour-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: min(240px, calc(100vw - 32px));
  max-width: min(420px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 96px));
  overflow: hidden;
  padding: 4px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  isolation: isolate;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-endeavour-menu-material {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--dsw-menu-surface-fill, var(--dsw-specific-menu));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  pointer-events: none;
}
.dsh-endeavour-menu-rows { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
.dsh-endeavour-menu-cell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: auto;
  min-width: 100%;
  /* Native root-row metric: 34px, 13/20 type, 0 8px padding, 6px gap. */
  height: 34px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
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
.dsh-endeavour-menu-cell-chevron { flex: 0 0 auto; color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-tertiary)); }
.dsh-endeavour-menu-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: auto;
  min-width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--dsw-radius-md);
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
  font-size: 13px;
  line-height: 18px;
  font-weight: 400;
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
/* Status tints. Working is the animated business-blue ring; Finished is the
   green check (reported, awaiting review); Confirmed is the same check in the
   host's violet-400 accent (ContextMeter's --meter-tint precedent, since DSH
   publishes no purple semantic token); the ephemeral "Challenger stopped" mark
   is warn orange; Waiting stays gray and Failed stays error red. */
.dsh-endeavour-glyph--pending { color: var(--dsw-alias-label-caption); }
.dsh-endeavour-glyph--running {
  color: var(--dsw-alias-state-business-primary);
  animation: dsh-endeavour-spin 1s linear infinite;
}
.dsh-endeavour-glyph--finished { color: var(--dsw-alias-state-success-primary); }
.dsh-endeavour-glyph--succeeded { color: rgb(167, 139, 250); }
.dsh-endeavour-glyph--interrupted { color: var(--dsw-alias-state-warn-primary); }
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
