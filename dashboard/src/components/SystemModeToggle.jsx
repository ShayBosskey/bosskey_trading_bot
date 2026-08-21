import { useState } from 'react';
import ModeConfirmModal from './ModeConfirmModal';

const MODES = [
  {
    id: 'CONSTRUCTION',
    label: 'Construction',
    accent: '#94a3b8',
    hint: 'Trading is disabled — the engine builds and analyses only.',
  },
  {
    id: 'PAPER',
    label: 'Paper',
    accent: '#3987e5',
    hint: 'Orders are simulated against live market data.',
  },
  {
    id: 'PRODUCTION',
    label: 'Production',
    accent: '#A1E533',
    hint: 'Orders are sent to the broker with real capital.',
  },
];

export default function SystemModeToggle({ mode, onModeChanged }) {
  const [candidate, setCandidate] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const activeIndex = MODES.findIndex((m) => m.id === mode);
  // The status endpoint may be down; never imply a mode we have not actually been told
  const activeMode = activeIndex === -1 ? null : MODES[activeIndex];
  const accent = activeMode ? activeMode.accent : '#94a3b8';

  const requestChange = (target) => {
    if (target.id === mode || pending) return;
    setError(null);
    setCandidate(target);
  };

  const cancelChange = () => {
    if (pending) return;
    setCandidate(null);
    setError(null);
  };

  const confirmChange = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/system/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMode: candidate.id }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Mode change rejected (HTTP ${res.status})`);

      setCandidate(null);
      // Pull fresh state so the dashboard reflects the mode the server actually reports
      await onModeChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800 mb-6 md:mb-8">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-gray-400 text-sm font-semibold mb-2">System Mode</h2>
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${activeMode ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: accent }}
            />
            <span className="text-xl md:text-2xl font-bold tracking-wide" style={{ color: accent }}>
              {activeMode ? activeMode.id : 'UNKNOWN'}
            </span>
          </div>
          <p className="text-gray-500 text-sm mt-1">
            {activeMode ? activeMode.hint : 'System status unavailable — the reported mode could not be read.'}
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="System mode"
          className="relative grid grid-cols-3 gap-1 p-1 bg-bosskey-dark rounded-xl border border-gray-800 w-full lg:w-auto lg:min-w-[380px]"
        >
          {/* Sliding indicator sits behind the labels and tracks the active mode */}
          {activeMode && (
            <span
              aria-hidden="true"
              className="absolute top-1 bottom-1 left-1 rounded-lg transition-transform duration-300 ease-out"
              style={{
                width: 'calc((100% - 1rem) / 3)',
                transform: `translateX(calc(${activeIndex} * (100% + 0.25rem)))`,
                backgroundColor: `${activeMode.accent}1F`,
                boxShadow: `inset 0 0 0 1px ${activeMode.accent}66`,
              }}
            />
          )}

          {MODES.map((m) => {
            const isActive = m.id === mode;
            return (
              <button
                key={m.id}
                role="radio"
                aria-checked={isActive}
                disabled={pending}
                onClick={() => requestChange(m)}
                className={`relative z-10 px-2 py-2 rounded-lg text-xs sm:text-sm font-bold tracking-wide transition-colors disabled:cursor-wait ${
                  isActive ? '' : 'text-gray-500 hover:text-white'
                }`}
                style={isActive ? { color: m.accent } : undefined}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && !candidate && (
        <p className="text-red-400 text-sm mt-3 break-words" role="alert">{error}</p>
      )}

      {candidate && (
        <ModeConfirmModal
          mode={candidate}
          current={activeMode ? activeMode.id : 'UNKNOWN'}
          pending={pending}
          error={error}
          onConfirm={confirmChange}
          onCancel={cancelChange}
        />
      )}
    </div>
  );
}
