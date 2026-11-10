import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

import { POT_COLORS, POT_FIELDS } from './chartPalette';

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-shefa-bg border border-gray-800 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-gray-300 font-semibold">{name}</p>
      <p className="text-white">${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
    </div>
  );
}

const pct = (share) => `${(share * 100).toFixed(share * 100 % 1 === 0 ? 0 : 1)}%`;

// potShares comes from the API (src/PotSplit.js), so the "of daily net" column
// is the rule Settlement actually applies, not a copy that can drift.
export default function CapitalPotsChart({ capital, potShares }) {
  const data = POT_FIELDS.map((field) => ({
    key: field.key,
    name: field.name,
    value: parseFloat(capital?.[field.key]) || 0,
    share: potShares?.[field.key],
  }));

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

      {/* Legend: identity is never color-alone */}
      <table className="w-full sm:w-auto text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wider">
            <th className="text-left font-semibold pb-2">Pot</th>
            <th className="text-right font-semibold pb-2 pl-4">Balance</th>
            <th className="text-right font-semibold pb-2 pl-4" title="Share of a winning day's net profit">Of daily net</th>
          </tr>
        </thead>
        <tbody>
          {data.map((pot) => (
            <tr key={pot.key} className={pot.key === 'shefa_fund' ? 'text-shefa-accent' : ''}>
              <td className="py-1.5">
                <span className="flex items-center gap-2 text-gray-300">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: POT_COLORS[pot.name] }}
                  />
                  <span className={pot.key === 'shefa_fund' ? 'text-shefa-accent font-semibold' : ''}>{pot.name}</span>
                </span>
              </td>
              <td className="py-1.5 pl-4 text-right font-semibold text-white tabular-nums">
                ${pot.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </td>
              <td className="py-1.5 pl-4 text-right text-gray-400 tabular-nums">
                {Number.isFinite(pot.share) ? pct(pot.share) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
