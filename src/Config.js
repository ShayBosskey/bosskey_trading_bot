require('dotenv').config({ path: '../.env' });

class Config {
    static getMode() {
        // Options: 'PRODUCTION', 'PAPER', 'CONSTRUCTION'
        return process.env.SYSTEM_MODE || 'CONSTRUCTION'; 
    }

    static isTradingAllowed() {
        const mode = this.getMode();
        if (mode === 'CONSTRUCTION') {
            return false;
        }
        return true;
    }
}

module.exports = Config;
