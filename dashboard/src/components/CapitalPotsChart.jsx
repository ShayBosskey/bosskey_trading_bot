import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

// Validated against the bosskey-panel dark surface (#161D22) with
// scripts/validate_palette.js from the dataviz skill — all checks pass.
const POT_COLORS = {
  'Active Capital': '#3987e5',
  'Emergency Reserve': '#d95926',
  'Tax Vault': '#199e70',
  'Personal Payout': '#c98500',
};

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-bosskey-dark border border-gray-800 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-gray-300 font-semibold">{name}</p>
      <p className="text-white">${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
    </div>
  );
}

export default function CapitalPotsChart({ capital }) {
  const data = [
    { name: 'Active Capital', value: parseFloat(capital.active_capital) || 0 },
    { name: 'Emergency Reserve', value: parseFloat(capital.emergency_reserve) || 0 },
    { name: 'Tax Vault', value: parseFloat(capital.tax_vault) || 0 },
    { name: 'Personal Payout', value: parseFloat(capital.personal_payout) || 0 },
  ];

  const total = data.reduce((sum, pot) => sum + pot.value, 0);

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative w-48 h-48 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="65%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
            >
              {data.map((pot) => (
                <Cell key={pot.name} fill={POT_COLORS[pot.name]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Total</span>
          <span className="text-white text-lg font-bold">
            ${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>
      </div>

      {/* Legend — identity is never color-alone */}
      <ul className="flex flex-col gap-3 w-full sm:w-auto">
        {data.map((pot) => (
          <li key={pot.name} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2 text-gray-300">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: POT_COLORS[pot.name] }}
              />
              {pot.name}
            </span>
            <span className="font-semibold text-white">
              ${pot.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
