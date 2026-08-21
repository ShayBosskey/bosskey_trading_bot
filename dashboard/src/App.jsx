import { useState, useEffect } from 'react';
import { LayoutDashboard, Wallet, Activity, ArrowUpRight } from 'lucide-react';

function App() {
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Because of our Vite proxy, this seamlessly routes to the PM2 backend
    fetch('/api/v1/portfolio')
      .then((res) => {
        if (!res.ok) throw new Error('API connection failed');
        return res.json();
      })
      .then((data) => {
        setPortfolio(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="flex h-screen items-center justify-center text-bosskey-green font-bold">Initializing System...</div>;
  if (error) return <div className="flex h-screen items-center justify-center text-red-500 font-bold">System Error: {error}</div>;

  return (
    <div className="flex h-screen bg-bosskey-dark text-white font-sans">
      
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-bosskey-panel flex flex-col p-6 rounded-r-3xl my-4 ml-4">
        <div className="flex items-center gap-3 mb-10 text-bosskey-green">
          <Activity size={32} />
          <h1 className="text-2xl font-extrabold tracking-wider">BOSSKEY</h1>
        </div>
        <nav className="flex flex-col gap-4">
          <button className="flex items-center gap-3 bg-bosskey-dark p-3 rounded-lg text-bosskey-green transition-colors">
            <LayoutDashboard size={20} />
            <span className="font-semibold">Dashboard</span>
          </button>
          <button className="flex items-center gap-3 hover:bg-bosskey-dark p-3 rounded-lg text-gray-400 hover:text-white transition-colors">
            <Wallet size={20} />
            <span className="font-semibold">Capital Pots</span>
          </button>
        </nav>
      </aside>

      {/* Main Dashboard Area */}
      <main className="flex-1 p-8">
        
        {/* Top Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          
          <div className="bg-bosskey-panel p-6 rounded-2xl shadow-lg border border-gray-800">
            <h2 className="text-gray-400 text-sm font-semibold mb-2">Active Capital</h2>
            <div className="flex items-end gap-3">
              <span className="text-4xl font-bold">${parseFloat(portfolio.capital.active_capital).toLocaleString()}</span>
              <span className="flex items-center text-bosskey-green text-sm font-bold bg-bosskey-green/10 px-2 py-1 rounded-md mb-1">
                <ArrowUpRight size={16} /> Live
              </span>
            </div>
          </div>

          <div className="bg-bosskey-panel p-6 rounded-2xl shadow-lg border border-gray-800">
            <h2 className="text-gray-400 text-sm font-semibold mb-2">Active Slots</h2>
            <div className="flex items-end gap-3">
              <span className="text-4xl font-bold">{portfolio.activeSlotCount} <span className="text-gray-500 text-2xl">/ {portfolio.maxSlots}</span></span>
            </div>
          </div>

        </div>

        {/* Active Positions Table */}
        <div className="bg-bosskey-panel rounded-2xl p-6 shadow-lg border border-gray-800">
          <h2 className="text-xl font-bold mb-6">Open Market Positions</h2>
          
          {portfolio.openPositions.length === 0 ? (
            <p className="text-gray-500">No active trades currently holding.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
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

      </main>
    </div>
  );
}

export default App;
