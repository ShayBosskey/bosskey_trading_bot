const Notifier = require('./Notifier');

function attachGlobalErrorLogger(scriptName) {
    const notifier = new Notifier();

    const handleCriticalError = async (errorType, err) => {
        // Format the local Swiss time
        const timestamp = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        console.error(`\n[CRITICAL SYSTEM FAILURE] ${timestamp}`);
        console.error(`Script: ${scriptName} | Type: ${errorType}`);
        console.error(`Error: ${errorMessage}`);
        if (err instanceof Error) console.error(err.stack);

        const pushBody = `Script: ${scriptName}\nTime: ${timestamp}\nError: ${errorMessage}`;
        
        // Await the push notification so the script doesn't die before it sends
        await notifier.push(
            "CRITICAL SYSTEM CRASH",
            pushBody,
            "rotating_light"
        );

        // Force a clean exit with a failure code
        process.exit(1);
    };

    // Catch all unhandled exceptions (synchronous crashes)
    process.on('uncaughtException', (err) => {
        handleCriticalError('Uncaught Exception', err);
    });

    // Catch all unhandled rejections (asynchronous promise crashes)
    process.on('unhandledRejection', (reason) => {
        handleCriticalError('Unhandled Rejection', reason);
    });
    
    console.log(`[System] Global Error Handler armed for ${scriptName}`);
}

module.exports = attachGlobalErrorLogger;
