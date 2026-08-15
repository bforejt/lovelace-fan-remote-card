import { LitElement, html, TemplateResult, css, CSSResultGroup } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { HomeAssistant, fireEvent, LovelaceCardEditor } from 'custom-card-helpers';

import type { FanRemoteCardConfig } from './types';

interface SchemaItem {
  name: string;
  required?: boolean;
  selector: Record<string, unknown>;
}

const SCHEMA: SchemaItem[] = [
  { name: 'entity', required: true, selector: { entity: { domain: 'fan' } } },
  { name: 'light_entity', selector: { entity: { domain: 'light' } } },
  { name: 'name', selector: { text: {} } },
  { name: 'icon', selector: { icon: {} } },
  {
    name: 'layout',
    selector: {
      select: {
        options: [
          { value: 'card', label: 'Card (default)' },
          { value: 'row', label: 'Row — compact single line' },
        ],
        mode: 'dropdown',
      },
    },
  },
  { name: 'show_speeds', selector: { boolean: {} } },
  { name: 'show_direction', selector: { boolean: {} } },
  { name: 'speed_count', selector: { number: { min: 2, max: 10, step: 1, mode: 'box' } } },
  { name: 'default_speed', selector: { number: { min: 1, max: 10, step: 1, mode: 'box' } } },
];

const LABELS: Record<string, string> = {
  entity: 'Fan entity (required)',
  light_entity: 'Light entity',
  name: 'Name',
  icon: 'Icon',
  layout: 'Layout',
  show_speeds: 'Show speed buttons',
  show_direction: 'Show direction control',
  speed_count: 'Speed count override',
  default_speed: 'Default speed',
};

const HELPERS: Record<string, string> = {
  light_entity: 'Adds a light-toggle button in the top-right corner',
  show_speeds: 'Turn off for fans that ignore speed (forward / reverse / off only)',
  show_direction: 'Only shown when the fan supports direction',
  speed_count: 'Leave empty to derive from the entity',
  default_speed: 'Speed sent on turn-on while speed buttons are hidden; empty = resume last speed',
};

@customElement('fan-remote-card-editor')
export class FanRemoteCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config?: FanRemoteCardConfig;

  public setConfig(config: FanRemoteCardConfig): void {
    this._config = config;
  }

  protected render(): TemplateResult {
    if (!this.hass || !this._config) {
      return html``;
    }

    return html`
      <ha-form
        .hass=${this.hass}
        .data=${this._config}
        .schema=${SCHEMA}
        .computeLabel=${this._computeLabel}
        .computeHelper=${this._computeHelper}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
  }

  private _computeLabel = (schema: SchemaItem): string => LABELS[schema.name] ?? schema.name;

  private _computeHelper = (schema: SchemaItem): string | undefined => HELPERS[schema.name];

  private _valueChanged(ev: CustomEvent): void {
    const config = { ...(ev.detail.value as FanRemoteCardConfig) };
    // Drop cleared optional keys so the stored YAML stays minimal.
    for (const key of Object.keys(config) as Array<keyof FanRemoteCardConfig>) {
      if (config[key] === '' || config[key] === undefined || config[key] === null) {
        delete config[key];
      }
    }
    fireEvent(this, 'config-changed', { config });
  }

  static get styles(): CSSResultGroup {
    return css`
      ha-form {
        display: block;
      }
    `;
  }
}
