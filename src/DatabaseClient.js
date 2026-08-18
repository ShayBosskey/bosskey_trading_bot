const { Client } = require('pg');

class DatabaseClient {
    constructor() {
        this.client = new Client({
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
        });
    }

    async connect() {
        await this.client.connect();
    }

    async getActiveCapital() {
        // Fetch the active capital from the latest row
        const res = await this.client.query('SELECT active_capital FROM capital_pots ORDER BY id DESC LIMIT 1');
        return parseFloat(res.rows[0].active_capital);
    }

    async disconnect() {
        await this.client.end();
    }
}

module.exports = DatabaseClient;
