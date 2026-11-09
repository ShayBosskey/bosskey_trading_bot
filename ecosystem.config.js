// PM2 apps for SHEFA's 24/7 crypto book. bosskey-api and bosskey-dashboard are
// managed separately and are deliberately not listed here.
//
//   pm2 start ecosystem.config.js --only crypto-exit-engine
//   pm2 save            # so the pm2-adminbosskey systemd unit resurrects it on boot
//
// Going live (paper) = drop '--dry-run' from the exit engine args, `pm2 reload`,
// then start crypto-trading-bot. The entry loop refuses to trade while the exit
// engine is in dry-run or its heartbeat is stale, so the order matters.
module.exports = {
    apps: [
        {
            name: 'crypto-exit-engine',
            script: 'src/CryptoExitEngine.js',
            args: '--dry-run',
            cwd: __dirname,
            autorestart: true,
            // Back off 100ms -> 15s on a crash loop instead of hammering Alpaca.
            exp_backoff_restart_delay: 100,
            max_memory_restart: '200M',
            kill_timeout: 10000,          // time for the SIGTERM handler to close the socket and DB pool
            time: true,
        },
        {
            name: 'crypto-trading-bot',
            script: 'CryptoTradingBot.js',
            cwd: __dirname,
            // One scan per run, every 15 minutes, 24/7.
            cron_restart: '*/15 * * * *',
            autorestart: false,
            time: true,
        },
    ],
};
