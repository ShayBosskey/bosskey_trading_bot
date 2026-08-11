// The Bosskey Alpha Universe - 40 High-Volume/Trending Equities
const TICKER_UNIVERSE = [
    // AI & Semiconductors (Processors, RAM, Foundry)
    'NVDA', 'AMD', 'TSM', 'MU', 'INTC', 'ASML', 'ARM', 'AVGO', 'QCOM', 'PLTR',
    
    // Tech Giants & Software
    'MSFT', 'GOOGL', 'AAPL', 'META', 'AMZN', 'NFLX', 'CRM', 'ADBE',
    
    // Electric Vehicles & Next-Gen Auto
    'TSLA', 'RIVN', 'LCID', 'NIO', 
    // (Note: BYD is traded OTC in the US as BYDDY. If Alpaca rejects it, remove it).
    'BYDDY',
    
    // Rare Earth Metals, Magnets, & Battery Materials
    'MP',   // MP Materials (Rare-earth magnets)
    'ALB',  // Albemarle (Lithium)
    'SQM',  // Sociedad Química y Minera (Lithium)
    'LAC',  // Lithium Americas
    
    // Fintech, Crypto Proxies, & Finance
    'COIN', 'HOOD', 'SQ', 'PYPL', 'JPM', 'V', 'MA',
    
    // Defense & Aerospace (SpaceX Alternatives)
    'LMT', 'RTX', 'BA', 'RKT'
];

module.exports = TICKER_UNIVERSE;
