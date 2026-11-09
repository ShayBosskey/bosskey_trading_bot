// PM2 apps for SHEFA's 24/7 crypto book. bosskey-api and bosskey-dashboard are
// managed separately and are deliberately not listed here.
//
//   pm2 start ecosystem.config.js --only crypto-exit-engine,crypto-exit-watchdog
//   pm2 save            # so the pm2-adminbosskey systemd unit resurrects it on boot
//
// Changing args needs `pm2 reload ecosystem.config.js --only <app>` (a plain
// `pm2 reload <app>` keeps the args PM2 stored), and the new value must be set
// explicitly - a removed key is not applied. Start the exit engine
// before crypto-trading-bot: entries are refused while its heartbeat is stale
// or it is in dry-run.
module.exports = {
    apps: [
        {
            name: 'crypto-exit-engine',
            script: 'src/CryptoExitEngine.js',
            // LIVE (paper) since 2026-11-10. Set args: ['--dry-run'] to stop it selling.
            // Explicit empty list: omitting the key would let PM2 keep stale args.
            args: [],
            cwd: __dirname,
            autorestart: true,
            // Back off 100ms -> 15s on a crash loop instead of hammering Alpaca.
            exp_backoff_restart_delay: 100,
            max_memory_restart: '200M',
            kill_timeout: 10000,          // time for the SIGTERM handler to close the socket and DB pool
            time: true,
        },
        {
            // Outside check on the exit engine: crashes that bypass its own error
            // handler (SIGKILL, OOM, hang, PM2 giving up) still ring the phone.
            name: 'crypto-exit-watchdog',
            script: 'src/ExitEngineWatchdog.js',
            cwd: __dirname,
            cron_restart: '*/2 * * * *',
            autorestart: false,
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
