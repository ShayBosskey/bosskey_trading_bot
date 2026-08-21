import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, Wallet, Activity, ArrowUpRight, Terminal } from 'lucide-react';
import CapitalPotsChart from './components/CapitalPotsChart';
import SystemModeToggle from './components/SystemModeToggle';

function App() {
  const [portfolio, setPortfolio] = useState(null);
  const [logs, setLogs] = useState([]);
  const [systemMode, setSystemMode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSystemData = useCallback(async () => {
    try {
      // Fetch every endpoint concurrently
      const [portfolioRes, logsRes, statusRes] = await Promise.all([
        fetch('/api/v1/portfolio'),
        fetch('/api/v1/logs'),
        fetch('/api/v1/system/status')
      ]);

      if (!portfolioRes.ok) throw new Error('API connection failed');

      const portfolioData = await portfolioRes.json();
      // If the logs table is empty or errors out initially, we fallback to an empty array
      const logsData = logsRes.ok ? await logsRes.json() : [];
      // The server is the source of truth for the mode; leave it untouched if status is down
      const statusData = statusRes.ok ? await statusRes.json() : null;

      setPortfolio(portfolioData);
      setLogs(logsData);
      if (statusData) setSystemMode(statusData.mode);
      // Clear any previous error so a later successful poll recovers the UI
      setError(null);
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch. The rule below fires on the useCallback reference, but every
    // setState in it runs after an await, so there is no cascading render to avoid.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSystemData();

    // Poll the PM2 API every 10 seconds for live updates
    const interval = setInterval(fetchSystemData, 10000);
    return () => clearInterval(interval);
  }, [fetchSystemData]);

  if (loading) return <div className="flex h-screen items-center justify-center text-bosskey-green font-bold px-4 text-center">Initializing System...</div>;
  if (error) return <div className="flex h-screen items-center justify-center text-red-500 font-bold px-4 text-center">System Error: {error}</div>;

  return (
    <div className="flex flex-col md:flex-row min-h-screen bg-bosskey-dark text-white font-sans md:overflow-hidden">

      {/* Sidebar Navigation */}
      <aside className="w-full md:w-64 bg-bosskey-panel flex flex-row md:flex-col items-center md:items-stretch justify-between md:justify-start gap-4 p-4 md:p-6 rounded-b-3xl md:rounded-b-none md:rounded-r-3xl md:my-4 md:ml-4">
        <div className="flex items-center gap-3 md:mb-10 text-bosskey-green">
          <Activity size={28} className="shrink-0" />
          <h1 className="text-xl md:text-2xl font-extrabold tracking-wider">BOSSKEY</h1>
        </div>
        <nav className="flex flex-row md:flex-col gap-2 md:gap-4">
          <button className="flex items-center gap-2 md:gap-3 bg-bosskey-dark p-2 md:p-3 rounded-lg text-bosskey-green transition-colors">
            <LayoutDashboard size={20} />
            <span className="hidden sm:inline font-semibold">Dashboard</span>
          </button>
          <button className="flex items-center gap-2 md:gap-3 hover:bg-bosskey-dark p-2 md:p-3 rounded-lg text-gray-400 hover:text-white transition-colors">
            <Wallet size={20} />
            <span className="hidden sm:inline font-semibold">Capital Pots</span>
          </button>
        </nav>
      </aside>

      {/* Main Dashboard Area */}
      <main className="flex-1 p-4 md:p-8 md:overflow-y-auto">

        {/* System Mode Control */}
        <SystemModeToggle mode={systemMode} onModeChanged={fetchSystemData} />

        {/* Top Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8">
          <div className="bg-bosskey-panel p-4 md:p-6 rounded-2xl shadow-lg border border-gray-800">
            <h2 className="text-gray-400 text-sm font-semibold mb-2">Active Capital</h2>
            <div className="flex items-end gap-3 flex-wrap">
              <span className="text-3xl md:text-4xl font-bold">${parseFloat(portfolio.capital.active_capital).toLocaleString()}</span>
              <span className="flex items-center text-bosskey-green text-sm font-bold bg-bosskey-green/10 px-2 py-1 rounded-md mb-1">
                <ArrowUpRight size={16} /> Live
              </span>
            </div>
          </div>

          <div className="bg-bosskey-panel p-4 md:p-6 rounded-2xl shadow-lg border border-gray-800">
            <h2 className="text-gray-400 text-sm font-semibold mb-2">Active Slots</h2>
            <div className="flex items-end gap-3">
              <span className="text-3xl md:text-4xl font-bold">{portfolio.activeSlotCount} <span className="text-gray-500 text-xl md:text-2xl">/ {portfolio.maxSlots}</span></span>
            </div>
          </div>
        </div>

        {/* Capital Pots Breakdown */}
        <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800 mb-6 md:mb-8">
          <h2 className="text-lg md:text-xl font-bold mb-6">Capital Pots</h2>
          <CapitalPotsChart capital={portfolio.capital} />
        </div>

        {/* Active Positions Table */}
        <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800 mb-6 md:mb-8">
          <h2 className="text-lg md:text-xl font-bold mb-6">Open Market Positions</h2>

          {portfolio.openPositions.length === 0 ? (
            <p className="text-gray-500">No active trades currently holding.</p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
              <table className="w-full min-w-[600px] text-left border-collapse">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800">
                    <th className="pb-3 font-semibold">Asset</th>
                    <th className="pb-3 font-semibold">Action</th>
                    <th className="pb-3 font-semibold">Quantity</th>
                    <th className="pb-3 font-semibold">Entry Price</th>
                    <th className="pb-3 font-semibold">Execution Time</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.openPositions.map((pos) => (
                    <tr key={pos.id} className="border-b border-gray-800/50 hover:bg-white/5 transition-colors">
                      <td className="py-4 font-bold">{pos.symbol}</td>
                      <td className="py-4">
                        <span className="bg-bosskey-green/10 text-bosskey-green px-3 py-1 rounded-full text-xs font-bold tracking-wider">
                          {pos.action}
                        </span>
                      </td>
                      <td className="py-4">{pos.qty}</td>
                      <td className="py-4">${parseFloat(pos.buy_price).toFixed(2)}</td>
                      <td className="py-4 text-gray-400 text-sm">{new Date(pos.opened_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Live System Feed (Logs) */}
        <div className="bg-bosskey-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800">
          <div className="flex items-center gap-3 mb-6">
            <Terminal size={24} className="text-bosskey-green" />
            <h2 className="text-lg md:text-xl font-bold">Live System Feed</h2>
          </div>

          <div className="h-64 overflow-y-auto pr-2 space-y-3">
            {logs.length === 0 ? (
              <p className="text-gray-500">No recent system activity...</p>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="flex flex-col bg-[#0B1115] p-3 rounded-lg border border-gray-800/50 border-l-2 border-l-bosskey-green">
                  <div className="flex justify-between items-center mb-1 gap-2">
                    <span className="text-bosskey-green text-xs font-bold uppercase tracking-wider">
                      {log.level || 'SYSTEM'}
                    </span>
                    <span className="text-gray-500 text-xs shrink-0">
                      {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'N/A'}
                    </span>
                  </div>
                  <p className="text-gray-300 text-sm break-words">{log.message}</p>
                </div>
              ))
            )}
          </div>
        </div>

      </main>
    </div>
  );
}

export default App;
