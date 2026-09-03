import { useMemo } from 'react';
import { TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, LabelList, ResponsiveContainer,
} from 'recharts';
import {
  POT_COLORS, POT_FIELDS, EQUITY_COLOR,
  GRID_COLOR, SURFACE_COLOR, AXIS_TEXT_COLOR,
} from './chartPalette';

const DAY_MS = 86400000;
const MOCK_DAYS = 30;

const usd = (value, digits = 2) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

// Compact form for axis ticks so the y-axis stays narrow on a phone.
const usdCompact = (value) => {
  const abs = Math.abs(value);
  if (abs >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
};

const shortDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Real equity curve from settled trades. Walks the cumulative net_profit forward
 * from the pre-trade baseline so the series lands exactly on today's equity.
 * Returns null when there is nothing settled yet, so the caller can fall back.
 */
function buildTimelineFromHistory(history, totalEquity) {
  if (!Array.isArray(history)) return null;

  const closed = history
    .filter((t) => t.closed_at && t.net_profit != null)
    .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));

  if (closed.length === 0) return null;

  const profits = closed.map((t) => parseFloat(t.net_profit) || 0);
  const netTotal = profits.reduce((sum, p) => sum + p, 0);

  let running = totalEquity - netTotal;
  const first = closed[0];
  const points = [{ date: first.opened_at || first.closed_at, equity: running }];

  closed.forEach((trade, i) => {
    running += profits[i];
    points.push({ date: trade.closed_at, equity: running });
  });

  return points;
}

/**
 * Deterministic placeholder timeline, anchored so the last point is the real
 * current equity. The seed is fixed on purpose: App polls every 10s, and a
 * re-randomised walk would make the card twitch on every poll.
 */
function buildMockTimeline(totalEquity, days = MOCK_DAYS) {
  let seed = 20260902;
  const rand = () => {
    seed = (seed * 16807) % 2147483647; // MINSTD — stays inside float53
    return seed / 2147483647;
  };

  const walk = [];
  let level = 1;
  for (let i = 0; i < days; i++) {
    level *= 1 + (rand() - 0.42) * 0.02; // mild upward drift
    walk.push(level);
  }

  const last = walk[walk.length - 1];
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  return walk.map((step, i) => ({
    date: new Date(midnight.getTime() - (days - 1 - i) * DAY_MS).toISOString(),
    equity: (totalEquity * step) / last,
  }));
}

function EquityTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-bosskey-dark border border-gray-800 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-gray-400 text-xs mb-1">{new Date(point.date).toLocaleString()}</p>
      <p className="text-white font-semibold">{usd(point.equity)}</p>
    </div>
  );
}

function PotTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const pot = payload[0].payload;
  return (
    <div className="bg-bosskey-dark border border-gray-800 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-gray-300 font-semibold">{pot.name}</p>
      <p className="text-white">{usd(pot.value)}</p>
      <p className="text-gray-400 text-xs mt-1">{pot.share.toFixed(1)}% of portfolio</p>
    </div>
  );
}

export default function PerformanceMetrics({ capital, history }) {
  const pots = useMemo(() => {
    const rows = POT_FIELDS.map((field) => ({
      name: field.name,
      short: field.short,
      value: parseFloat(capital?.[field.key]) || 0,
    }));
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return rows.map((row) => ({
      ...row,
      share: total > 0 ? (row.value / total) * 100 : 0,
    }));
  }, [capital]);

  const totalEquity = useMemo(
    () => pots.reduce((sum, pot) => sum + pot.value, 0),
    [pots],
  );

  const { timeline, isMock } = useMemo(() => {
    const real = buildTimelineFromHistory(history, totalEquity);
    return real
      ? { timeline: real, isMock: false }
      : { timeline: buildMockTimeline(totalEquity), isMock: true };
  }, [history, totalEquity]);

  const opening = timeline[0]?.equity ?? 0;
  const change = totalEquity - opening;
  const changePct = opening > 0 ? (change / opening) * 100 : 0;
  const isUp = change >= 0;
  const TrendIcon = isUp ? TrendingUp : TrendingDown;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8">

      {/* Equity Over Time */}
      <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg md:text-xl font-bold">Equity Over Time</h2>
            <p className="text-gray-500 text-xs mt-1">
              {isMock
                ? `Sample timeline · last ${MOCK_DAYS} days`
                : `${timeline.length - 1} settled trades`}
            </p>
          </div>
          {isMock && (
            <span className="text-amber-400/90 bg-amber-400/10 border border-amber-400/20 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider shrink-0">
              Sample Data
            </span>
          )}
        </div>

        <div className="flex items-end gap-3 flex-wrap mb-4">
          <span className="text-2xl md:text-3xl font-bold">{usd(totalEquity)}</span>
          <span
            className={`flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md mb-1 ${
              isUp
                ? 'text-bosskey-green bg-bosskey-green/10'
                : 'text-red-400 bg-red-400/10'
            }`}
          >
            <TrendIcon size={16} />
            {isUp ? '+' : '−'}{usd(Math.abs(change))} ({Math.abs(changePct).toFixed(2)}%)
          </span>
        </div>

        <div className="h-56 sm:h-64 -ml-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeline} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="equityWash" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={EQUITY_COLOR} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={EQUITY_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={usdCompact}
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={56}
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={<EquityTooltip />}
                cursor={{ stroke: GRID_COLOR, strokeWidth: 1 }}
              />
              <Area
                type="monotone"
                dataKey="equity"
                stroke={EQUITY_COLOR}
                strokeWidth={2}
                fill="url(#equityWash)"
                dot={false}
                activeDot={{ r: 4, fill: EQUITY_COLOR, stroke: SURFACE_COLOR, strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Capital Pot Allocations */}
      <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800">
        <div className="flex items-center gap-3 mb-4">
          <BarChart3 size={22} className="text-bosskey-green shrink-0" />
          <div>
            <h2 className="text-lg md:text-xl font-bold">Capital Pot Allocations</h2>
            <p className="text-gray-500 text-xs mt-1">Balance held per pot</p>
          </div>
        </div>

        {/* Horizontal bars: pot names read straight off the axis at any width,
            so nothing collides on a phone and identity is never colour-alone. */}
        <div className="h-56 sm:h-64 mt-8">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={pots}
              layout="vertical"
              margin={{ top: 0, right: 64, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={usdCompact}
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="short"
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip content={<PotTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="value" barSize={20} radius={[0, 4, 4, 0]}>
                {pots.map((pot) => (
                  <Cell key={pot.name} fill={POT_COLORS[pot.name]} />
                ))}
                <LabelList
                  dataKey="value"
                  position="right"
                  formatter={(value) => usdCompact(value)}
                  fill="#9CA3AF"
                  fontSize={11}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  );
}
