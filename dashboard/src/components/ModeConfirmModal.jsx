import { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';

export default function ModeConfirmModal({ mode, current, pending, error, onConfirm, onCancel }) {
  const confirmRef = useRef(null);

  // Focus the confirm action on open and let Escape back out of a mode change
  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pending, onCancel]);

  const isLive = mode.id === 'PRODUCTION';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mode-confirm-title"
        className="w-full max-w-md bg-bosskey-panel border border-gray-800 rounded-2xl shadow-2xl p-5 md:p-6"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <span
              className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0"
              style={{ backgroundColor: `${mode.accent}1F`, color: mode.accent }}
            >
              <AlertTriangle size={20} />
            </span>
            <h2 id="mode-confirm-title" className="text-lg font-bold text-white">
              Confirm Mode Change
            </h2>
          </div>
          <button
            onClick={onCancel}
            disabled={pending}
            aria-label="Cancel mode change"
            className="text-gray-500 hover:text-white transition-colors disabled:opacity-40 disabled:hover:text-gray-500"
          >
            <X size={20} />
          </button>
        </div>

        <p className="text-gray-300 mb-2">
          Are you sure you want to change the system to{' '}
          <span className="font-bold" style={{ color: mode.accent }}>{mode.id}</span>?
        </p>
        <p className="text-gray-500 text-sm mb-4">
          Current mode is <span className="font-semibold text-gray-400">{current}</span>. {mode.hint}
        </p>

        {isLive && (
          <div className="flex gap-3 bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
            <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">
              PRODUCTION places live broker orders with real capital. Only proceed if the strategy
              has been validated in PAPER.
            </p>
          </div>
        )}

        {error && (
          <p className="text-red-400 text-sm mb-4 break-words" role="alert">{error}</p>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-2 rounded-lg font-semibold text-gray-300 bg-bosskey-dark border border-gray-800 hover:text-white hover:border-gray-700 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={pending}
            className="px-4 py-2 rounded-lg font-bold text-bosskey-dark bg-bosskey-green hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-wait"
          >
            {pending ? 'Switching...' : `Switch to ${mode.id}`}
          </button>
        </div>
      </div>
    </div>
  );
}
