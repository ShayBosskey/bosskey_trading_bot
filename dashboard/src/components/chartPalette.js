// Shared chart palette. Pot colors are the dataviz categorical slots stepped for
// a dark surface; every one clears 4.5:1 against shefa-panel (#18131F):
// blue 5.0, orange 4.7, green 5.4, gold 5.9, violet 5.9.
//
// Keyed by pot so a pot keeps the same hue in every chart: color follows the
// entity, never its position in a series. SHEFA's own fund wears her violet.
export const POT_COLORS = {
  'Active Capital': '#3987e5',
  'Emergency Reserve': '#d95926',
  'Tax Vault': '#199e70',
  'Personal Payout': '#c98500',
  'SHEFA Fund': '#a77bf0',
};

// Single-series hue for the equity curve (sequential default, blue 400).
// The brand violet (#7851A9) is only 3.1:1 on the panel, so it stays a UI
// accent and never carries data.
export const EQUITY_COLOR = '#3987e5';

// Host telemetry line (CPU load). A lighter violet, 5.3:1 on the panel.
export const HEALTH_COLOR = '#9B7BD1';

// Recessive chrome: one shade off the panel surface.
export const GRID_COLOR = '#2A2236';
export const SURFACE_COLOR = '#18131F';
export const AXIS_TEXT_COLOR = '#6B7280';

export const POT_FIELDS = [
  { key: 'active_capital', name: 'Active Capital', short: 'Active' },
  { key: 'emergency_reserve', name: 'Emergency Reserve', short: 'Reserve' },
  { key: 'tax_vault', name: 'Tax Vault', short: 'Tax' },
  { key: 'personal_payout', name: 'Personal Payout', short: 'Payout' },
  { key: 'shefa_fund', name: 'SHEFA Fund', short: 'SHEFA' },
];
