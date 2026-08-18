const DatabaseClient = require('./DatabaseClient');

class Logger {
    constructor(processName) {
        this.processName = processName;
        this.db = new DatabaseClient();
    }

    async log(message) {
        const now = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
        console.log(`[${now}] [${this.processName}] ${message}`);

        try {
            await this.db.connect();
            await this.db.client.query(
                'INSERT INTO system_logs (process, message) VALUES ($1, $2)',
                [this.processName, message]
            );
        } catch (err) {
            console.error(`[Logger Error] Failed to write to DB: ${err.message}`);
        } finally {
            await this.db.disconnect();
        }
    }
}

module.exports = Logger;
