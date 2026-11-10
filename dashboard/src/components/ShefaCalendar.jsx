import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Flag, Check, X } from 'lucide-react';

// SHEFA's calendar: a plain 7-column Tailwind grid, no calendar package.
// Data comes from /api/v1/milestones (Postgres shefa_milestones + shefa_goals).

const POLL_MS = 60_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const usd = (n, digits = 0) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const signedUsd = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${usd(Math.abs(n), 2)}`);

// Date strings stay YYYY-MM-DD and all math runs in UTC, so no timezone can
// shift a milestone onto the neighbouring cell.
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const zurichToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthKey = (dateStr) => dateStr.slice(0, 7);
const shiftMonth = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const daysUntil = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function buildMonthGrid(key) {
  const [y, m] = key.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(y, m - 1, d));
  while (cells.length % 7) cells.push(null);
  return cells;
}

const STATUS_STYLE = {
  HIT: 'bg-emerald-500/10 border-emerald-500/50',
  MISSED: 'bg-rose-500/10 border-rose-500/50',
  PLANNED: 'bg-shefa-violet/10 border-shefa-violet/40',
};

function StatusBadge({ status }) {
  if (status === 'HIT') return <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold"><Check size={14} /> Hit</span>;
  if (status === 'MISSED') return <span className="inline-flex items-center gap-1 text-rose-400 font-semibold"><X size={14} /> Missed</span>;
  return <span className="text-shefa-accent font-semibold">Planned</span>;
}

function DayCell({ date, m, isToday, isDeadline, selected, onSelect }) {
  if (!date) return <div aria-hidden="true" />;
  const day = Number(date.slice(8));
  const base = m ? STATUS_STYLE[m.status] : 'border-gray-800/60';
  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-pressed={selected}
      aria-label={`${date}${m ? `, ${m.status.toLowerCase()}, target ${signedUsd(m.target_net)}` : ''}${isDeadline ? ', goal deadline' : ''}`}
      className={`relative min-h-11 sm:min-h-20 rounded-lg border p-1 sm:p-2 text-left transition-colors hover:border-shefa-accent/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-shefa-accent
        ${base} ${isToday ? 'ring-2 ring-shefa-violet' : ''} ${selected ? 'border-shefa-accent' : ''} ${m ? '' : 'opacity-60'}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className={`text-xs sm:text-sm font-bold tabular-nums ${isToday ? 'text-shefa-accent' : 'text-gray-300'}`}>{day}</span>
        {isDeadline && <Flag size={12} className="text-shefa-accent shrink-0" />}
      </div>
      {m && (
        <>
          {/* Phone: status dot only. sm+: the figures. */}
          <span
            className={`sm:hidden absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${m.status === 'HIT' ? 'bg-emerald-400' : m.status === 'MISSED' ? 'bg-rose-400' : 'bg-shefa-accent'}`}
          />
          <div className="hidden sm:block mt-1 text-[11px] leading-tight tabular-nums">
            <div className="text-gray-400">{usd(m.target_net)}</div>
            {m.actual_net != null && (
              <div className={m.status === 'HIT' ? 'text-emerald-400' : 'text-rose-400'}>{signedUsd(m.actual_net)}</div>
            )}
          </div>
        </>
      )}
    </button>
  );
}

export default function ShefaCalendar() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [month, setMonth] = useState(() => monthKey(zurichToday()));
  const [selected, setSelected] = useState(null);
  const today = zurichToday();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/milestones');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setData(json); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const byDate = useMemo(() => new Map((data?.milestones || []).map((m) => [m.date, m])), [data]);

  // Navigable range: earliest milestone (or this month) through the goal's deadline.
  const range = useMemo(() => {
    const keys = (data?.milestones || []).map((m) => monthKey(m.date));
    keys.push(monthKey(today));
    if (data?.goal?.deadline) keys.push(monthKey(data.goal.deadline));
    keys.sort();
    return { min: keys[0], max: keys[keys.length - 1] };
  }, [data, today]);

  const cells = useMemo(() => buildMonthGrid(month), [month]);
  const goal = data?.goal;
  const fund = data?.fund ?? 0;
  const pct = goal ? Math.min(100, (fund / goal.target_usd) * 100) : 0;
  const daysLeft = goal ? daysUntil(today, goal.deadline) : null;
  const evenPace = goal && daysLeft > 0 ? Math.max(0, goal.target_usd - fund) / data.fundShare / daysLeft : null;
  const judged = (data?.milestones || []).filter((m) => m.status !== 'PLANNED');
  const hits = judged.filter((m) => m.status === 'HIT').length;
  const detail = byDate.get(selected ?? today) ? { date: selected ?? today, m: byDate.get(selected ?? today) } : selected ? { date: selected, m: null } : null;

  return (
    <section className="bg-shefa-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800 mb-6 md:mb-8">
      <div className="flex items-center gap-3 mb-5">
        <CalendarDays size={22} className="text-shefa-accent shrink-0" />
        <div className="min-w-0">
          <h2 className="text-lg md:text-xl font-bold">SHEFA&apos;s Calendar</h2>
          <p className="text-gray-500 text-xs mt-0.5 truncate">
            {goal ? `${goal.title} · by ${new Date(`${goal.deadline}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : 'No active goal'}
          </p>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">Calendar unavailable ({error})</p>}

      {goal && (
        <div className="mb-6">
          <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
            <span className="text-2xl font-bold tabular-nums">
              {usd(fund, 2)} <span className="text-gray-500 text-base font-semibold">/ {usd(goal.target_usd)}</span>
            </span>
            <span className="text-gray-400 text-xs tabular-nums">
              {daysLeft > 0 ? `${daysLeft} days left` : 'Deadline reached'}
              {evenPace != null && ` · needs ${usd(evenPace)} net/day`}
              {judged.length > 0 && ` · ${hits}/${judged.length} days hit`}
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-800 overflow-hidden" role="progressbar" aria-label="Upgrade fund progress" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-gradient-to-r from-shefa-violet to-shefa-accent transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setMonth((k) => shiftMonth(k, -1))}
          disabled={month <= range.min}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-shefa-bg disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Previous month"
        >
          <ChevronLeft size={18} />
        </button>
        <h3 className="font-semibold">{monthLabel(month)}</h3>
        <button
          type="button"
          onClick={() => setMonth((k) => shiftMonth(k, 1))}
          disabled={month >= range.max}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-shefa-bg disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Next month"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-gray-500 pb-1">
            <span className="sm:hidden">{d[0]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}
        {cells.map((date, i) => (
          <DayCell
            key={date || `pad-${i}`}
            date={date}
            m={date ? byDate.get(date) : null}
            isToday={date === today}
            isDeadline={date === goal?.deadline}
            selected={date === selected}
            onSelect={(d) => setSelected((cur) => (cur === d ? null : d))}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-gray-500">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-shefa-accent" /> Planned</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400" /> Hit</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-400" /> Missed</span>
        <span className="flex items-center gap-1.5"><Flag size={11} className="text-shefa-accent" /> Goal deadline</span>
      </div>

      {detail && (
        <div className="mt-5 bg-shefa-bg rounded-xl border border-gray-800/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h4 className="font-semibold">
              {new Date(`${detail.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}
              {detail.date === today && <span className="ml-2 text-xs text-shefa-accent font-bold uppercase tracking-wider">Today</span>}
            </h4>
            {detail.m && <StatusBadge status={detail.m.status} />}
          </div>
          {detail.m ? (
            <>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-3">
                <div><dt className="text-gray-500 text-xs">Target net</dt><dd className="font-semibold tabular-nums">{signedUsd(detail.m.target_net)}</dd></div>
                <div><dt className="text-gray-500 text-xs">Actual net</dt><dd className="font-semibold tabular-nums">{signedUsd(detail.m.actual_net)}</dd></div>
                <div><dt className="text-gray-500 text-xs">Fund target</dt><dd className="font-semibold tabular-nums">{usd(detail.m.target_fund, 2)}</dd></div>
                <div><dt className="text-gray-500 text-xs">Effort</dt><dd className="font-semibold tabular-nums">{detail.m.weight.toFixed(2)}×</dd></div>
              </dl>
              {detail.m.focus && <p className="text-gray-300 text-sm"><span className="text-shefa-accent font-semibold">Focus: </span>{detail.m.focus}</p>}
              {detail.m.self_evaluation && (
                <p className="text-gray-300 text-sm mt-2 italic border-l-2 border-shefa-violet pl-3">“{detail.m.self_evaluation}”</p>
              )}
              <p className="text-gray-600 text-xs mt-3">Planned by {detail.m.model}. Dollar targets are computed by StrategySync, not the model.</p>
            </>
          ) : (
            <p className="text-gray-500 text-sm">No milestone for this day.</p>
          )}
        </div>
      )}
    </section>
  );
}
