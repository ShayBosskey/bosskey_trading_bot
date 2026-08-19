const DatabaseClient = require('./DatabaseClient');

class Logger {
    constructor(processName) {
        this.processName = processName;
    }

    async log(message) {
        const now = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
        console.log(`[${now}] [${this.processName}] ${message}`);

        // Instantiate a completely fresh client for every single log
        const db = new DatabaseClient(); 
        try {
            await db.connect();
            await db.client.query(
                'INSERT INTO system_logs (process, message) VALUES ($1, $2)',
                [this.processName, message]
            );
        } catch (err) {
            console.error(`[Logger Error] Failed to write to DB: ${err.message}`);
        } finally {
            await db.disconnect(); // Cleanly kill the fresh client
        }
    }
}

module.exports = Logger;
