require('dotenv').config({ path: '../.env' });
const { Client } = require('pg');

class DatabaseClient {
    constructor() {
        this.client = new Client({
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            host: process.env.PGHOST,
            port: process.env.PGPORT,
            database: process.env.PGDATABASE
        });
    }

    async connect() {
        await this.client.connect();
    }

    async getActiveCapital() {
        const potsRes = await this.client.query('SELECT pot_name, balance FROM capital_pots ORDER BY pot_id ASC;');
        return parseFloat(potsRes.rows[0].balance);
    }

    async disconnect() {
        await this.client.end();
    }
}

module.exports = DatabaseClient;
