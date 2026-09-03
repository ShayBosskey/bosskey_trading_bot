// Shared chart palette. Colors are the dataviz categorical slots 1-4 stepped for
// a dark surface, validated against bosskey-panel (#161D22) with
// scripts/validate_palette.js — all six checks pass.
//
// Keyed by pot so a pot keeps the same hue in every chart: color follows the
// entity, never its position in a series.
export const POT_COLORS = {
  'Active Capital': '#3987e5',
  'Emergency Reserve': '#d95926',
  'Tax Vault': '#199e70',
  'Personal Payout': '#c98500',
};

// Single-series hue for the equity curve (sequential default, blue 400).
// The brand green (#A1E533) fails the dark lightness band, so it stays a UI
// accent and never carries data.
export const EQUITY_COLOR = '#3987e5';

// Recessive chrome: one shade off the panel surface.
export const GRID_COLOR = '#232B31';
export const SURFACE_COLOR = '#161D22';
export const AXIS_TEXT_COLOR = '#6B7280';

export const POT_FIELDS = [
  { key: 'active_capital', name: 'Active Capital', short: 'Active' },
  { key: 'emergency_reserve', name: 'Emergency Reserve', short: 'Reserve' },
  { key: 'tax_vault', name: 'Tax Vault', short: 'Tax' },
  { key: 'personal_payout', name: 'Personal Payout', short: 'Payout' },
];
