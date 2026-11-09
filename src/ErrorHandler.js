const Notifier = require('./Notifier');
const VoiceEscalator = require('./VoiceEscalator');
const { redact } = require('./Redactor');

function attachGlobalErrorLogger(scriptName) {
    const notifier = new Notifier();
    const voiceEscalator = new VoiceEscalator();

    let handling = false;

    const handleCriticalError = async (errorType, err) => {
        // A second error while the first is still alerting must not double-push
        // or race the exit.
        if (handling) return;
        handling = true;

        // Format the local Swiss time
        const timestamp = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
        const errorMessage = redact(err instanceof Error ? err.message : String(err));
        
        console.error(`\n[CRITICAL SYSTEM FAILURE] ${timestamp}`);
        console.error(`Script: ${scriptName} | Type: ${errorType}`);
        console.error(`Error: ${errorMessage}`);
        if (err instanceof Error) console.error(redact(err.stack));

        const pushBody = `Script: ${scriptName}\nTime: ${timestamp}\nError: ${errorMessage}`;
        
        // Await both so the script doesn't die before they send. Neither throws,
        // and the voice call request is capped by its own short timeout.
        await Promise.all([
            notifier.push(
                "CRITICAL SYSTEM CRASH",
                pushBody,
                "rotating_light"
            ),
            voiceEscalator.escalate(`${scriptName} crashed`, `${errorType}: ${errorMessage}`)
        ]);

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
