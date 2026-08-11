class Notifier {
    constructor() {
        // Updated to your exact secure topic
        this.topicUrl = 'https://ntfy.sh/bosskey_trading_rasp_200';
    }

    async push(title, message, tags = "") {
        try {
            const safeTitle = title.replace(/[^\x00-\x7F]/g, "").trim();

            await fetch(this.topicUrl, {
                method: 'POST',
                body: message,
                headers: {
                    'Title': safeTitle,
                    'Tags': tags 
                }
            });
            console.log(`[Notifier] 📱 Push notification sent: "${safeTitle}"`);
        } catch (err) {
            console.error("\n[Notifier Error]:", err.message);
        }
    }
}

module.exports = Notifier;
