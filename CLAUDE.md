# CLAUDE.md — lovelace-fan-remote-card

Context for AI-assisted development in this repo. Read fully before making changes.
This file is the design spec of record; update it when decisions change.

## What this is

A Lovelace custom card that renders a multi-speed fan the way its physical remote
works: N discrete speed buttons (derived from the entity, not hardcoded), corner
buttons for all-off and light, optional direction control. Entity-generic — works
with any HA `fan` entity that exposes discrete speeds (ESPHome, Bond, Tuya,
SmartWings, Zigbee canopy modules).

Origin: reverse-engineered 433.92 MHz OOK ceiling fans (B99/EV1527 framing,
ESP32 + CC1101 via ESPHome). That protocol sends **absolute discrete** speed
commands, with light and direction as independent frames. Stock/mushroom fan
cards render a percentage slider — a lossy continuous UI over discrete absolute
state. This card is the frontend companion to that ESPHome work but must never
couple to it: consume the standard fan entity model only. Cross-linking the
ESPHome project happens in the README ("companion projects"), nowhere in code.

Prior art (all inadequate, do not copy architecture from them):
`fan-percent-button-row` / `fan-mode-button-row` / `fan-control-entity-row` are
entity rows hardcoded to 2–3 speeds + off; `ikohs-fan-card` is
integration-specific and requires manually listing speed modes.

## Naming

- Repo: `lovelace-fan-remote-card`. HACS strips the `lovelace-` prefix, so the
  built file MUST be `fan-remote-card.js`.
- Element tag: `fan-remote-card`, card type `custom:fan-remote-card`,
  class `FanRemoteCard`, display name "Fan Remote Card".
- Rename sweep from boilerplate: `package.json`, rollup config output filename,
  `src/const.ts`, element definitions, editor element, README badges.

## Layout spec

```
┌─────────────────────────────────┐
│ [⏻]                        [💡] │   corner ha-icon-buttons (absolute pos)
│                                 │
│            (fan icon)           │   master power: tap = fan.toggle, hold = more-info
│            Green Fan            │
│          Speed 4 of 6           │
│                                 │
│  ┌───┬───┬───┬───┬───┬───┐ (↻)  │   N speed segments + optional direction
│  │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │      │
│  └───┴───┴───┴───┴───┴───┘      │
└─────────────────────────────────┘
```

- Root is `ha-card` with `position: relative`; corners are absolutely
  positioned `ha-icon-button`s overlaying the top padding, sized as 48 px
  touch targets (28 px icons) for the kiosk tablets.
- Top-left: all-off. Default `mdi:power` (NOT `mdi:power-off` — that MDI
  glyph is a bare hollow circle with no power symbol, useless affordance).
  Colored bright green — `--fan-remote-power-on-color`, fallback `#00c853`
  (deliberately NOT `--success-color`: theme values are too muted to read at
  a glance on the tablets) — while the fan OR the configured light is on,
  `--secondary-text-color` when everything is off. No optimistic flip on
  tap; it goes gray when hass reports off. Default action:
  `fan.turn_off` plus `light.turn_off` on `light_entity` if configured.
  Overridable via `all_off_action` (standard HA action config, so a script
  call works).
- Top-right: light toggle, only rendered when `light_entity` is set.
  `mdi:lightbulb` in both states — `--state-light-on-color` (fallback amber)
  when on, `--secondary-text-color` when off. Same-glyph color-state
  convention as the fan icon; no slashed off-glyph.
- Center column: icon, name (default `friendly_name`), status line: `Off` /
  `Speed {active} of {n}` / `On` / `Unavailable`, with ` · Forward|Reverse`
  appended whenever the direction control is shown — the only place a
  stopped fan's STORED direction (what a bare turn-on will use) is
  discoverable. The icon is the **master power**
  and defaults to `mdi:fan` in both states: `--secondary-text-color` and
  static when off, `--primary-color` and spinning while on (CSS rotation,
  period scaled to speed, honors `prefers-reduced-motion`; `icon` config
  overrides it). Same icon on/off is deliberate — state reads through color
  and motion, not glyph swaps.
- Segment row (`show_speeds: true`, the default): N equal-width buttons,
  **numeral labels only** (must fit 6 segments in a ~330 px masonry column on
  a 1024×600 tablet). Buttons are 48 px tall (same touch-target standard as
  the corners); when N > 6 the row wraps into two rows of `ceil(N/2)` columns
  so segments stay finger-sized. Active segment filled `--primary-color`;
  inactive use `--secondary-background-color` with `--primary-text-color`.
  Controls are live in every state except unavailable — see the interaction
  model section: one press does what it says, from any state.
- `show_speeds: false` (fans that ignore speed, e.g. forward/reverse/off
  units): the segment row is not rendered, the status line reads
  `On[ · Forward|Reverse]` / `Off`, and turn-on paths send
  `default_speed` as percentage when configured (otherwise the device resumes
  its remembered speed). With direction also hidden, the card collapses to
  corners + center icon.
- Direction (only when `show_direction: true` AND entity `supported_features`
  includes DIRECTION):
  - speeds shown: single toggle button right of the segment row,
    `mdi:rotate-right` / `mdi:rotate-left` reflecting current
    `attributes.direction`; tap sets the opposite direction.
  - speeds hidden: a two-segment absolute row `[↻ Forward | ↺ Reverse]` in
    the segment row's place — tap the state you want, like the remote's F/R
    buttons. The pressed side fills `--primary-color` only while the fan is
    on (a stopped fan has no active direction).
- Fire the `haptic` event (`"light"`) on every button tap for the companion app.

## Interaction model — physical-remote parity (ground truth: sister project)

The behavioral reference is `ceiling-fans-stateful.yaml` in the
`esphome-cc1101-ceiling-fan` sister project (read it before changing
interaction semantics; the card stays decoupled in code — standard fan
services only — but its semantics are a direct extension of that stateful
bridge). Rules:

- **One press does what it says, from any state.** Never gate controls on
  power state; never force two presses where the remote needs one. Only
  `unavailable`/`unknown` disables controls.
- **The card never diffs against current state before sending.** The
  bridge's on_state reconciler is idempotent and transmits only differences,
  so redundant sends are simply free. (This is why tapping the active
  segment re-sends instead of no-oping.) NOTE: a re-press is NOT a resync —
  the reconciler diffs a no-change call to ZERO frames on air. Drift healing
  on the bridge is All Off, a different speed, or the bridge's raw per-unit
  "All Off" button entity.
- **Tap actions branch on the DISPLAYED state, not raw entity state.** A fan
  at state 'on' + percentage 0 renders as "Off" (stopped); the center tap
  must then send turn_on. Display and action must never disagree — one press
  does what the displayed state promises. (Same rule colors the power
  corner: green tracks the displayed running state, not raw 'on'.)
- **All-off and drift (bridge deployments):** the default corner action uses
  entity services, which the bridge diff-gates — if HA already assumes
  everything is off, a drifted fan/light gets ZERO frames. For bridge units,
  set `all_off_action` to `perform-action` → `button.press` on the unit's
  raw "All Off" button entity: it always transmits the atomic 0x06 frame and
  force-syncs, which is the bridge's designed resync affordance.
- **Speed is absolute and doubles as turn-on** (Speed N is the turn-on
  frame; the bridge follows it with a direction assert). Segment taps send
  `fan.set_percentage` from any state.
- **Bare turn-on resumes the device-remembered speed** (kept on-device,
  1..n, never 0, survives off) — so center-icon turn-on sends no percentage
  unless the card pins one (`show_speeds: false` + `default_speed`).
- **Direction from a stop starts the fan** (the bridge's RX decoder mirrors
  a physical F/R press from stop as fan-start at remembered speed). The
  bridge intentionally defers a bare `set_direction` while off, so the card
  composes `fan.set_direction` + `fan.turn_on`; the reconciler then emits
  the verified `[Speed N, then F/R]` start sequence. While on,
  `set_direction` alone (immediate, speed-preserving).

## Config schema

```yaml
type: custom:fan-remote-card
entity: fan.green_fan                # required, domain: fan
light_entity: light.green_fan_light  # optional
name: Green Fan                      # optional, defaults to friendly_name
icon: mdi:ceiling-fan                # optional, default mdi:fan (spins while on)
show_speeds: true                    # optional, default true; false = fan ignores speed
show_direction: false                # optional, default false
speed_count: 6                       # optional override, see derivation rules
default_speed: 3                     # optional, 1-10; percentage sent on turn-on when
                                     #   show_speeds is false (else device resumes memory)
all_off_action:                      # optional, standard HA action config
  action: perform-action
  perform_action: script.green_room_all_off
```

`setConfig` validation: `entity` present and `fan.` domain, `speed_count` (if
set) integer 2–10, `default_speed` (if set) integer 1–10 and ≤ `speed_count`
when both are set. Throw descriptive errors — they render in the card slot.

## Entity model and derivation (core logic — get this exactly right)

```
step   = stateObj.attributes.percentage_step
n      = config.speed_count ?? (step ? clamp(round(100 / step), 2, 10) : null)
         → if n is null AND show_speeds is true, render an error card: entity
           does not expose discrete speeds; suggest setting speed_count or
           using a stock card. With show_speeds: false a null n is fine (the
           card is on/off/direction only; default_speed is then ignored).
active = (state === 'on' && attributes.percentage != null)
           ? (round(attributes.percentage / (100 / n)) < 1
               ? 0   // state 'on' + percentage 0 (MQTT/template fans) is a
                     // stopped fan — never clamp up to a phantom speed 1
               : min(round(attributes.percentage / (100 / n)), n))
           : 0
```

- Speed segment `i` tapped → `fan.set_percentage` with
  `percentage: Math.round(i * 100 / n)`. HA/ESPHome rounds to the nearest
  supported speed, so 17/33/50/67/83/100 is correct for n=6; do not chase
  exact floats.
- `config.speed_count` always wins over the derived value (covers integrations
  with wrong/absent `percentage_step`, e.g. some Tuya fans).
- `unavailable` / `unknown`: disable all controls, style the card with
  `--warning-color` accents (maintainer convention: yellow = unavailable).
- No optimistic local state. ESPHome fan entities are assumed-state and report
  immediately; always render from `hass`. One-way RF means HA state is the
  source of truth by definition.

## Service call map

| Control                  | Service                           | Data / target                             |
|--------------------------|-----------------------------------|-------------------------------------------|
| Speed segment i          | `fan.set_percentage`              | `percentage: round(i * 100 / n)`, any state |
| Center icon tap (on)     | `fan.turn_off`                    | `entity_id: config.entity`                |
| Center icon tap (off)    | `fan.turn_on`                     | + `percentage` only when pinned (see interaction model) |
| Center icon hold         | fire `hass-more-info`             | `entityId: config.entity`                 |
| All-off (default)        | `fan.turn_off` + `light.turn_off` | fan + light_entity                        |
| All-off (override)       | per `all_off_action`              | standard action-config handling           |
| Light corner             | `light.toggle`                    | `entity_id: config.light_entity`          |
| Direction (fan on)       | `fan.set_direction`               | `direction: forward\|reverse`             |
| Direction (fan off)      | `fan.set_direction` + `fan.turn_on` | starts the fan in that direction (remote F/R parity) |

## Implementation notes

- tsconfig MUST keep `"useDefineForClassFields": false`. With target es2022
  it defaults to true, and the emitted class fields shadow Lit's reactive
  accessors: the card renders once and silently never updates on `hass`
  changes. The dev harness has a live-update self-test that catches this.

- Base: `custom-cards/boilerplate-card` template (TypeScript, LitElement,
  rollup, devcontainer that auto-starts HA at `localhost:8123` with hot
  reload). Keep its action-handler directive for tap/hold.
- **Hand-roll the segment row** as styled `<button>`s. Do NOT import HA
  internal components (`ha-control-select`, etc.) — undocumented API, breaks
  across HA releases. `ha-card`, `ha-icon`, `ha-icon-button` are long-stable
  and fine.
- Theming: CSS custom properties only, no hardcoded colors. Palette:
  `--primary-color`, `--primary-text-color`, `--secondary-text-color`,
  `--disabled-text-color`, `--warning-color`, `--card-background-color`,
  `--secondary-background-color`, `--ha-card-border-radius`.
- Implement `getCardSize()` AND `getGridOptions()` (sections sizing: columns
  min/default, rows). Card must behave in both masonry and sections views.
- Register in `window.customCards` with `type`, `name`, `description`,
  `preview: true`, `documentationURL`.
- `getEntitySuggestion(hass, entityId)` (HA 2026.6+ card-picker suggestions):
  return a config suggestion only for `fan.` entities whose `percentage_step`
  implies 3–8 speeds. Harmless no-op on older HA — no version guard needed.
- Visual editor: `getConfigElement()` using `ha-form` schema — entity selector
  (domain fan), entity selector (domain light), name text, icon selector,
  boolean, integer. `getStubConfig()` picks the first fan entity.
- Localization: en only for v1; keep the boilerplate localize plumbing, trim
  unused languages.

## HACS publishing

`hacs.json` at repo root:

```json
{
  "name": "Fan Remote Card",
  "filename": "fan-remote-card.js",
  "render_readme": true
}
```

- Repo requirements: public, GitHub description set, topics set
  (`home-assistant`, `hacs`, `lovelace`, `custom-card`, `fan`, `ceiling-fan`,
  `fan-remote`), README with install + config docs and screenshots.
- Build output `dist/fan-remote-card.js`. Release workflow: on GitHub release
  publish → build → attach the js to the release as an asset. HACS file search
  order is `dist/` → latest release → repo root. Tags alone are NOT enough;
  publish actual releases.
- Default-store inclusion (later): repo active, ≥1 release, owner submits the
  PR to `hacs/default`. Until merged, install path is HACS custom repository —
  use that for dogfooding immediately.

## Milestones

- **v0.1** — rename sweep; render + full service-call map; YAML config only;
  works on maintainer masonry dashboards. Definition of done: controls Green
  fan + light from the Green-AI tablet.
- **v0.2** — visual editor; direction control; `getGridOptions` verified in a
  sections test dashboard; unavailable/error states polished.
- **v1.0** — README + screenshots; release workflow attaching dist asset;
  installable as HACS custom repo; `getEntitySuggestion`.
- **v1.x** — submit to `hacs/default`; README companion-projects link to the
  ESPHome RF fan work when published; consider optional off-segment and
  per-speed labels if requested by users.

## Non-goals (v1)

`preset_mode`-based fans, oscillation, percentage-slider fallback mode, fan
groups, custom per-speed labels, embedded protocol/RF logic of any kind.

## Maintainer test environment

- HA 2026.7.x on HAOS / Pi 5. Dashboards are masonry with vertical-stack
  columns; kiosk tablets at 1024×600 (Green-AI) and 1280×800 (Office-AI,
  Guest-AI). ~330 px effective column width is the design constraint.
- Test fans are 6-speed B99/EV1527 units driven by ESPHome + CC1101 (Green,
  Office, Guest rooms). Verify exact entity IDs against the live instance
  before wiring test configs — do not trust the IDs in examples above.
- One-way RF: there is no external state feedback; entity assumed-state is
  authoritative. Do not build reconciliation logic.
