class FundamentalClient {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
    }

    async hasUpcomingEarnings(symbol) {
        if (!this.apiKey || this.apiKey === 'dummy_key') {
            console.warn(`[Fundamental Warning] No valid Finnhub API key found. Skipping earnings risk check for ${symbol}.`);
            return false; 
        }

        try {
            const today = new Date().toISOString().split('T')[0];
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 5);
            const toDate = futureDate.toISOString().split('T')[0];

            const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${toDate}&symbol=${symbol}&token=${this.apiKey}`;
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`Finnhub API responded with status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.earningsCalendar && data.earningsCalendar.length > 0) {
                console.log(`[Fundamental] EVENT RISK DETECTED: ${symbol} reports earnings on ${data.earningsCalendar[0].date}. Setup rejected.`);
                return true;
            }

            return false;
        } catch (err) {
            console.error(`[Fundamental Error] Failed to fetch earnings for ${symbol}: ${err.message}`);
            // If the API fails, we assume no risk to keep the system running, but we log the failure.
            return false;
        }
    }
}

module.exports = FundamentalClient;
