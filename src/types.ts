import { ActionConfig, LovelaceCard, LovelaceCardConfig, LovelaceCardEditor } from 'custom-card-helpers';

declare global {
  interface HTMLElementTagNameMap {
    'fan-remote-card-editor': LovelaceCardEditor;
    'hui-error-card': LovelaceCard;
  }
}

export interface FanRemoteCardConfig extends LovelaceCardConfig {
  type: string;
  entity: string;
  light_entity?: string;
  name?: string;
  icon?: string;
  layout?: 'card' | 'row';
  show_speeds?: boolean;
  show_direction?: boolean;
  speed_count?: number;
  default_speed?: number;
  all_off_action?: ActionConfig;
}
