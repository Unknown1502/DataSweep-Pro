# Interface

The design decisions behind the shell, and the measurements behind them. The
README states the rules; this states how they were arrived at and what they cost.

## Colour is assigned by meaning

| | |
|---|---|
| blue-cyan | the action you can take, and where you are |
| violet | something an agent did |
| amber | an external MCP client, or a value we are unsure of |
| red | a security finding, or a destructive change |
| green | a confirmed pass |

Prior state is carried by de-emphasis rather than by a hue — the past should
recede — which leaves amber free for the one meaning it now has. An earlier
palette spent amber on "the prior value", which left no colour for actor
attribution.

Status is never carried by colour alone: each actor has its own icon, the active
tab has a rule as well as a tint, and rule results show a pass/fail glyph.

## The surface ramp was measured, not picked by eye

Converting the palette to OKLCH surfaced two defects that were invisible on a
good monitor and obvious in numbers:

- `shell-700` (L 22.9) was **lighter** than `surface-900` (L 21.3), so the chrome
  and the working surface sat at the same value. That is why the app read flat:
  there was no elevation to see.
- `line` (L 29.1) was lighter than `surface-700` (L 26.8), so a border was
  brighter than the card it enclosed on some surfaces and not others.

Every step is now at least 3.4 in OKLCH lightness — roughly where a step stays
visible on a dim laptop screen rather than only on a calibrated one — and the
chrome sits strictly below the workspace.

Two more surfaced while rebuilding:

- The scrollbar thumb measured **1.47:1** against its track, where 3:1 is the
  requirement. It is now its own token at 3.97:1, because it has a constraint the
  surface ramp does not.
- `agent-dim` and `danger-dim` measured *darker* than the corrected cards, so an
  alert would have read as a hole punched in the panel. Every tinted callout now
  sits one clear step above the card.

The five accent hues were measured and **left alone**. They already sit within
six points of each other in OKLCH lightness at similar chroma, which is what
makes them read as peers rather than one shouting over the others. Only `agent`
and `danger` moved, by two points each, to hold contrast against the lightened
cards.

Contrast was then checked for every foreground against every surface it can land
on. The floor is **4.57:1**. The single pairing below AA — `fg-subtle` on
`surface-600` at 3.84:1 — cannot occur: `surface-600` is only ever a meter track
or a button hover, and the button carries `fg` at 9.89:1.

## Elevation is a lit edge, not a shadow

On a dark ground a blurred shadow mostly dissolves into it. What reads as raised
is the lit top edge, because that is what a real edge does under overhead light.
Shadows are kept for things that genuinely float — dialogs — and need to detach
from the page.

## The segmented gauge

The one signature element. A smooth bar is the shape of an estimate, and this
product's argument is that its figures are measured; discrete segments read as
counted units, which is what a score out of 100 is.

A tick marks where the score stood at the first scan, so the bar shows movement
rather than only a destination. The baseline is written once per dataset and
never overwritten, and is labelled "at first scan" because that is exactly what
it is — claiming more would be a guess.

The number is always printed beside it, so the gauge is never the sole carrier of
the value. That is what makes it safe for the segments to disappear under forced
colors.

Two bugs found while building it: the tick was originally inside the CSS mask and
vanished whenever it landed in a segment gap, and at 5px the segments merged into
a hatched texture that said nothing the old bar had not.

## Platform behaviour

- `accent-color` themes the browser's own controls, so checkboxes and radios
  match without being rebuilt and losing their native semantics.
- `forced-colors` fallbacks are defined, since that mode strips `background-image`
  and `box-shadow`. Nothing conveys meaning through those alone; the gauge gets a
  real border so its extent survives.
- `prefers-contrast: more` gets a scrollbar that is actually visible.
- `prefers-reduced-motion` collapses every transition.

## Layout

A three-column shell: navigation, workspace, agent activity. The workspace uses
tabs because showing all eight panes at once produced a page you had to scroll
past to reach anything.

The layout works down to a 390px phone: navigation becomes a drawer and agent
activity a full-screen overlay, closed by default so a small screen lands on the
data rather than on a panel covering it.

Components are Radix primitives in `src/components/ui/`, wired to the project's
own tokens rather than a second parallel palette. Dialogs trap focus, are
labelled, close on Escape, lock background scroll and restore focus.

## The data grid sorts in SQL

The alternative — loading the table into React state for a client-side table
library — would be slower and would cap the openable file at whatever fits in JS
memory, while DuckDB sits in the same tab able to sort millions of rows.

Sorting is numeric-aware. Columns are VARCHAR by design, so a plain text sort
puts `875000` before `980.50`. Ordering by the parsed number first and the raw
text second gets both kinds of column right in one expression.

This is honest rather than hidden about its edge: a column of European-format
numbers sorts wrong until it is parsed. `1.290,50` strips to 1.29 and sorts low,
because the app has not been told that column is European yet. `parse_numbers`
fixes both the value and the sort.

## Keyboard

Press `?` for the full list. Undo and redo are `Ctrl/Cmd+Z` and
`Ctrl/Cmd+Shift+Z`, bound to React state rather than to synthesised clicks on
buttons that will move.
