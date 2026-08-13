import { LitElement, html, css, nothing, TemplateResult, PropertyValues, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { HassEntity } from 'home-assistant-js-websocket';
import {
  HomeAssistant,
  LovelaceCardEditor,
  ActionConfig,
  ActionHandlerEvent,
  handleAction,
  forwardHaptic,
  fireEvent,
} from 'custom-card-helpers';

import type { FanRemoteCardConfig } from './types';
import { actionHandler } from './action-handler-directive';
import { CARD_VERSION, FAN_SUPPORT_DIRECTION } from './const';
import { localize } from './localize/localize';

console.info(
  `%c  FAN-REMOTE-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

interface WindowWithCustomCards extends Window {
  customCards: Array<{
    type: string;
    name: string;
    description: string;
    preview?: boolean;
    documentationURL?: string;
  }>;
}

(window as unknown as WindowWithCustomCards).customCards =
  (window as unknown as WindowWithCustomCards).customCards || [];
(window as unknown as WindowWithCustomCards).customCards.push({
  type: 'fan-remote-card',
  name: 'Fan Remote Card',
  description: 'Discrete speed buttons for multi-speed fans, laid out like the physical remote.',
  preview: true,
  documentationURL: 'https://github.com/bforejt/lovelace-fan-remote-card',
});

@customElement('fan-remote-card')
export class FanRemoteCard extends LitElement {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import('./editor');
    return document.createElement('fan-remote-card-editor');
  }

  public static getStubConfig(hass?: HomeAssistant, entities?: string[]): Record<string, unknown> {
    const pool = entities?.length ? entities : Object.keys(hass?.states ?? {});
    const firstFan = pool.find((entityId) => entityId.startsWith('fan.'));
    return { entity: firstFan ?? '' };
  }

  // HA 2026.6+ card-picker suggestions; older frontends simply never call this.
  public static getEntitySuggestion(hass: HomeAssistant, entityId: string): Record<string, unknown> | undefined {
    if (!entityId.startsWith('fan.')) {
      return undefined;
    }
    const step = Number(hass.states[entityId]?.attributes.percentage_step);
    if (!step || !isFinite(step) || step <= 0) {
      return undefined;
    }
    const speeds = Math.round(100 / step);
    if (speeds < 3 || speeds > 8) {
      return undefined;
    }
    return { type: 'custom:fan-remote-card', entity: entityId };
  }

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private config!: FanRemoteCardConfig;

  public setConfig(config: FanRemoteCardConfig): void {
    if (!config || !config.entity) {
      throw new Error(localize('error.entity_required'));
    }
    if (!config.entity.startsWith('fan.')) {
      throw new Error(localize('error.entity_not_fan') + config.entity);
    }
    if (
      config.speed_count !== undefined &&
      (!Number.isInteger(config.speed_count) || config.speed_count < 2 || config.speed_count > 10)
    ) {
      throw new Error(localize('error.speed_count_invalid'));
    }
    if (
      config.default_speed !== undefined &&
      (!Number.isInteger(config.default_speed) ||
        config.default_speed < 1 ||
        config.default_speed > 10 ||
        (config.speed_count !== undefined && config.default_speed > config.speed_count))
    ) {
      throw new Error(localize('error.default_speed_invalid'));
    }

    this.config = {
      show_direction: false,
      show_speeds: true,
      ...config,
    };
  }

  // Sizing consults hass when it is set (it usually is at layout time) so
  // derived speed counts and direction support size correctly; the
  // config-only estimate is the fallback for early calls.
  private _configRows(): number {
    const stateObj = this.hass?.states?.[this.config?.entity ?? ''];
    if (this.config?.show_speeds === false) {
      const supportsDirection = stateObj
        ? (Number(stateObj.attributes.supported_features) & FAN_SUPPORT_DIRECTION) !== 0
        : true;
      return this.config?.show_direction && supportsDirection ? 3 : 2;
    }
    let speedCount = this.config?.speed_count ?? 0;
    if (!speedCount && stateObj) {
      speedCount = this._speedCount(stateObj) ?? 0;
    }
    return speedCount > 6 ? 4 : 3;
  }

  public getCardSize(): number {
    return this._configRows() + 1;
  }

  public getGridOptions(): Record<string, number> {
    const rows = this._configRows();
    return {
      columns: 12,
      min_columns: 6,
      rows,
      min_rows: Math.min(3, rows),
    };
  }

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false;
    }
    if (changedProps.has('config')) {
      return true;
    }
    const oldHass = changedProps.get('hass') as HomeAssistant | undefined;
    if (!oldHass) {
      return true;
    }
    return [this.config.entity, this.config.light_entity]
      .filter((id): id is string => Boolean(id))
      .some((id) => oldHass.states[id] !== this.hass.states[id]);
  }

  // ── Derivation (see CLAUDE.md: entity model) ────────────────────────────

  private _speedCount(stateObj: HassEntity): number | null {
    if (this.config.speed_count) {
      return this.config.speed_count;
    }
    const step = Number(stateObj.attributes.percentage_step);
    if (!step || !isFinite(step) || step <= 0) {
      return null;
    }
    return Math.min(10, Math.max(2, Math.round(100 / step)));
  }

  private _activeSpeed(stateObj: HassEntity, speedCount: number): number {
    const percentage = stateObj.attributes.percentage;
    if (stateObj.state !== 'on' || percentage == null) {
      return 0;
    }
    // percentage 0 while state 'on' (MQTT/template fans) is a stopped fan:
    // report 0 rather than clamping up to a phantom speed 1.
    const speed = Math.round(Number(percentage) / (100 / speedCount));
    return speed < 1 ? 0 : Math.min(speedCount, speed);
  }

  // Percentage to send on the turn-on paths when the speed row is hidden and
  // a default_speed is configured; null means "let the device resume its
  // remembered speed" (the stateful bridge keeps last fixed speed on-device).
  private _turnOnPercentage(stateObj: HassEntity): number | null {
    if (this.config.show_speeds !== false || !this.config.default_speed) {
      return null;
    }
    const speedCount = this._speedCount(stateObj);
    if (!speedCount) {
      return null;
    }
    const speed = Math.min(this.config.default_speed, speedCount);
    return Math.round((speed * 100) / speedCount);
  }

  // ── Render ──────────────────────────────────────────────────────────────

  protected render(): TemplateResult | typeof nothing {
    if (!this.hass || !this.config) {
      return nothing;
    }

    const stateObj = this.hass.states[this.config.entity];
    if (!stateObj) {
      return this._showError(localize('error.entity_not_found') + this.config.entity);
    }

    const showSpeeds = this.config.show_speeds !== false;
    const speedCount = this._speedCount(stateObj);
    if (showSpeeds && speedCount === null) {
      return this._showError(localize('error.no_discrete_speeds'));
    }

    const unavailable = stateObj.state === 'unavailable' || stateObj.state === 'unknown';
    const isOn = stateObj.state === 'on';
    const active = unavailable || speedCount === null ? 0 : this._activeSpeed(stateObj, speedCount);
    const name = this.config.name ?? stateObj.attributes.friendly_name ?? this.config.entity;

    const showDirection =
      this.config.show_direction === true &&
      (Number(stateObj.attributes.supported_features) & FAN_SUPPORT_DIRECTION) !== 0;
    const directionReverse = stateObj.attributes.direction === 'reverse';

    // Speeds hidden: the fan runs whenever it reports on. Speeds shown:
    // on + percentage 0 is a stopped fan, so the icon holds still too.
    const running = showSpeeds ? active > 0 : isOn && !unavailable;
    const spinPeriod = active > 0 ? (3.6 / active).toFixed(2) : '1.80';

    // Direction is part of the status whenever the control is shown — it is
    // the only place the STORED direction of a stopped fan is discoverable
    // (a bare turn-on will start the fan in exactly that direction).
    const dirSuffix =
      showDirection && stateObj.attributes.direction
        ? ` · ${localize(directionReverse ? 'state.reverse' : 'state.forward')}`
        : '';
    const status = unavailable
      ? localize('state.unavailable')
      : (showSpeeds
          ? active === 0
            ? localize('state.off')
            : localize('state.speed', { active, total: speedCount as number })
          : running
            ? localize('state.on')
            : localize('state.off')) + dirSuffix;

    const lightObj = this.config.light_entity ? this.hass.states[this.config.light_entity] : undefined;
    const lightOn = lightObj?.state === 'on';

    return html`
      <ha-card class=${classMap({ unavailable })}>
        <ha-icon-button
          class="corner top-left ${running || lightOn ? 'power-on' : ''}"
          .label=${localize('label.all_off')}
          .disabled=${unavailable}
          @click=${this._handleAllOff}
        >
          <ha-icon icon="mdi:power"></ha-icon>
        </ha-icon-button>

        ${this.config.light_entity
          ? html`
              <ha-icon-button
                class="corner top-right ${lightOn ? 'light-on' : ''}"
                .label=${localize('label.light')}
                .disabled=${!lightObj || lightObj.state === 'unavailable'}
                @click=${this._handleLightToggle}
              >
                <ha-icon icon="mdi:lightbulb"></ha-icon>
              </ha-icon-button>
            `
          : nothing}

        <div
          class="center"
          role="button"
          tabindex="0"
          aria-label=${name}
          aria-disabled=${unavailable}
          @action=${this._handleFanAction}
          ${actionHandler({ hasHold: true })}
        >
          <ha-icon
            class=${classMap({ 'fan-icon': true, on: running, spinning: running })}
            icon=${this.config.icon ?? 'mdi:fan'}
            style=${running ? `animation-duration: ${spinPeriod}s` : ''}
          ></ha-icon>
          <div class="name">${name}</div>
          <div class="status">${status}</div>
        </div>

        ${showSpeeds
          ? html`
              <div class="controls">
                <div
                  class="segments"
                  role="group"
                  aria-label=${localize('label.speed')}
                  style="grid-template-columns: repeat(${(speedCount as number) > 6
                    ? Math.ceil((speedCount as number) / 2)
                    : speedCount}, 1fr)"
                >
                  ${Array.from({ length: speedCount as number }, (_, index) => index + 1).map(
                    (speed) => html`
                      <button
                        class=${classMap({ segment: true, active: speed === active })}
                        .disabled=${unavailable}
                        aria-pressed=${speed === active}
                        aria-label=${`${localize('label.speed')} ${speed}`}
                        @click=${(): void => this._handleSpeedTap(speed, speedCount as number)}
                      >
                        ${speed}
                      </button>
                    `,
                  )}
                </div>
                ${showDirection
                  ? html`
                      <button
                        class="segment direction"
                        .disabled=${unavailable}
                        aria-label=${localize('label.switch_direction', {
                          direction: localize(directionReverse ? 'state.forward' : 'state.reverse'),
                        })}
                        @click=${this._handleDirectionToggle}
                      >
                        <ha-icon icon=${directionReverse ? 'mdi:rotate-left' : 'mdi:rotate-right'}></ha-icon>
                      </button>
                    `
                  : nothing}
              </div>
            `
          : showDirection
            ? html`
                <div class="controls">
                  <div
                    class="segments"
                    role="group"
                    aria-label=${localize('label.direction')}
                    style="grid-template-columns: repeat(2, 1fr)"
                  >
                    <button
                      class=${classMap({ segment: true, 'dir-seg': true, active: isOn && !directionReverse })}
                      .disabled=${unavailable}
                      aria-pressed=${isOn && !directionReverse}
                      @click=${(): void => this._setDirection('forward')}
                    >
                      <ha-icon icon="mdi:rotate-right"></ha-icon>${localize('state.forward')}
                    </button>
                    <button
                      class=${classMap({ segment: true, 'dir-seg': true, active: isOn && directionReverse })}
                      .disabled=${unavailable}
                      aria-pressed=${isOn && directionReverse}
                      @click=${(): void => this._setDirection('reverse')}
                    >
                      <ha-icon icon="mdi:rotate-left"></ha-icon>${localize('state.reverse')}
                    </button>
                  </div>
                </div>
              `
            : nothing}
      </ha-card>
    `;
  }

  // ── Actions (see CLAUDE.md: service call map + interaction model) ────────
  //
  // One press does what it says, from any state — physical-remote parity.
  // The card sends absolute commands and never diffs against current state:
  // the stateful ESPHome bridge's reconciler diffs on-device (idempotent),
  // so redundant sends are simply free — NOT a resync; a no-diff call puts
  // nothing on air. Drift healing lives in All Off / picking another speed.

  private _haptic(): void {
    forwardHaptic('light');
  }

  private _handleSpeedTap(speed: number, speedCount: number): void {
    this._haptic();
    // Absolute speed doubles as turn-on (Speed N is the turn-on frame).
    this.hass.callService('fan', 'set_percentage', {
      entity_id: this.config.entity,
      percentage: Math.round((speed * 100) / speedCount),
    });
  }

  private _handleFanAction(ev: ActionHandlerEvent): void {
    if (ev.detail.action === 'hold') {
      // More-info stays reachable when unavailable — useful for diagnosis.
      fireEvent(this, 'hass-more-info', { entityId: this.config.entity });
      return;
    }
    if (ev.detail.action !== 'tap') {
      return;
    }
    const stateObj = this.hass.states[this.config.entity];
    if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      return;
    }
    this._haptic();
    // Branch on the same notion the DISPLAY uses, not raw state: a fan at
    // state 'on' + percentage 0 renders as "Off" (stopped), so the tap must
    // send turn_on — one press does what the displayed state promises.
    const speedCount = this._speedCount(stateObj);
    const displayedOn =
      this.config.show_speeds !== false && speedCount !== null
        ? this._activeSpeed(stateObj, speedCount) > 0
        : stateObj.state === 'on';
    if (displayedOn) {
      this.hass.callService('fan', 'turn_off', { entity_id: this.config.entity });
      return;
    }
    // Bare turn-on: the device resumes its remembered speed unless the card
    // is configured to pin one (hidden speed row + default_speed).
    const percentage = this._turnOnPercentage(stateObj);
    this.hass.callService('fan', 'turn_on', {
      entity_id: this.config.entity,
      ...(percentage != null ? { percentage } : {}),
    });
  }

  private _handleDirectionToggle(): void {
    const stateObj = this.hass.states[this.config.entity];
    this._setDirection(stateObj?.attributes.direction === 'reverse' ? 'forward' : 'reverse');
  }

  private _setDirection(direction: 'forward' | 'reverse'): void {
    const stateObj = this.hass.states[this.config.entity];
    if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      return;
    }
    this._haptic();
    this.hass.callService('fan', 'set_direction', {
      entity_id: this.config.entity,
      direction,
    });
    if (stateObj.state !== 'on') {
      // Physical-remote parity: F/R from a stop STARTS the fan (the sister
      // project's RX decoder mirrors exactly this). The stateful bridge
      // defers a bare set_direction while off, so the card adds the turn-on;
      // the reconciler emits the verified [Speed N, then F/R] sequence.
      const percentage = this._turnOnPercentage(stateObj);
      this.hass.callService('fan', 'turn_on', {
        entity_id: this.config.entity,
        ...(percentage != null ? { percentage } : {}),
      });
    }
  }

  private _handleAllOff(): void {
    const stateObj = this.hass.states[this.config.entity];
    if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      return;
    }
    this._haptic();
    if (this.config.all_off_action) {
      this._runAction(this.config.all_off_action);
      return;
    }
    this.hass.callService('fan', 'turn_off', { entity_id: this.config.entity });
    if (this.config.light_entity) {
      this.hass.callService('light', 'turn_off', { entity_id: this.config.light_entity });
    }
  }

  private _handleLightToggle(): void {
    const lightObj = this.config.light_entity ? this.hass.states[this.config.light_entity] : undefined;
    if (!lightObj || lightObj.state === 'unavailable') {
      return;
    }
    this._haptic();
    this.hass.callService('light', 'toggle', { entity_id: this.config.light_entity });
  }

  private _runAction(action: ActionConfig): void {
    // Normalize modern HA action spellings to the `call-service` form
    // custom-card-helpers understands: it only reads `service` and
    // `service_data`, while HA configs may use `perform_action` and `data`.
    const raw = action as unknown as Record<string, unknown>;
    const normalized = (raw.action === 'perform-action' || raw.action === 'call-service'
      ? {
          ...raw,
          action: 'call-service',
          service: raw.perform_action ?? raw.service,
          service_data: raw.data ?? raw.service_data,
        }
      : raw) as unknown as ActionConfig;
    handleAction(this, this.hass, { entity: this.config.entity, tap_action: normalized }, 'tap');
  }

  private _showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config,
    });

    return html`${errorCard}`;
  }

  // ── Styles ──────────────────────────────────────────────────────────────

  static get styles(): CSSResultGroup {
    return css`
      ha-card {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 12px 12px;
        height: 100%;
        box-sizing: border-box;
      }

      .corner {
        position: absolute;
        top: 4px;
        color: var(--secondary-text-color);
        /* 48px touch targets for the kiosk tablets. */
        --mdc-icon-button-size: 48px;
        --mdc-icon-size: 28px;
      }
      .corner.top-left {
        left: 4px;
      }
      .corner.top-right {
        right: 4px;
      }
      .corner.light-on {
        color: var(--state-light-on-color, var(--amber-color, #ffc107));
      }
      .corner.power-on {
        /* Bright by design — themes' --success-color is often too muted to
           read at a glance on a wall tablet. */
        color: var(--fan-remote-power-on-color, #00c853);
      }
      .corner[disabled] {
        color: var(--disabled-text-color);
      }

      .center {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        cursor: pointer;
        outline: none;
        margin: 0 52px;
      }
      .center:focus-visible {
        border-radius: 8px;
        box-shadow: 0 0 0 2px var(--primary-color);
      }

      .fan-icon {
        display: block;
        --mdc-icon-size: 48px;
        color: var(--secondary-text-color);
      }
      .fan-icon.on {
        color: var(--primary-color);
      }
      .fan-icon.spinning {
        animation: fan-spin 2s linear infinite;
      }
      @keyframes fan-spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .fan-icon.spinning {
          animation: none;
        }
      }

      .name {
        margin-top: 4px;
        font-size: 16px;
        font-weight: 500;
        color: var(--primary-text-color);
      }

      .status {
        font-size: 13px;
        color: var(--secondary-text-color);
      }

      .controls {
        display: flex;
        gap: 6px;
      }

      .segments {
        flex: 1;
        display: grid;
        /* Column count comes from an inline style; >6 speeds wrap onto two
           rows so segments stay finger-sized in a ~330px column. */
        gap: 4px;
        min-width: 0;
      }

      .segment {
        min-width: 0;
        /* Match the 48px corner touch targets. */
        height: 48px;
        padding: 0;
        border: none;
        border-radius: 8px;
        background: var(--secondary-background-color);
        color: var(--primary-text-color);
        font: inherit;
        font-size: 14px;
        font-weight: 500;
        line-height: 48px;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .segment.active {
        background: var(--primary-color);
        color: var(--text-primary-color, var(--card-background-color));
      }
      .segment:disabled {
        /* Visibly revoke the tappable-pill affordance, not just the numeral
           color — kiosk users get no other feedback from a dead button. */
        opacity: 0.4;
        color: var(--disabled-text-color);
        cursor: not-allowed;
      }

      .dir-seg {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        line-height: normal;
        --mdc-icon-size: 20px;
      }

      .direction {
        flex: 0 0 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--secondary-text-color);
        --mdc-icon-size: 20px;
      }

      /* Maintainer convention: yellow = unavailable. */
      ha-card.unavailable .fan-icon,
      ha-card.unavailable .status {
        color: var(--warning-color);
      }
      ha-card.unavailable .center {
        cursor: default;
      }
    `;
  }
}
