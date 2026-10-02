import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getIdsByTicker, getIdsById, guessIds } from "@/lib/token-mappings";
export const dynamic = "force-dynamic";

const app = new Hono().basePath("/api");

// In-memory cache for API responses
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

const cache = new Map<string, CacheEntry<any>>();

// Cache TTL constants (in milliseconds)
const CACHE_TTL_COIN_LIST = 5 * 60 * 1000; // 5 minutes
const CACHE_TTL_COIN_DATA = 2 * 60 * 1000; // 2 minutes

// Helper function to get cache key
function getCacheKey(type: string, id?: string): string {
  return id ? `${type}:${id}` : type;
}

// Helper function to get cached data
function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  
  const now = Date.now();
  if (now - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return null;
  }
  
  return entry.data as T;
}

// Helper function to set cache
function setCache<T>(key: string, data: T, ttl: number): void {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl,
  });
}

app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "hono-agent",
  });
});

app.get("/coins", (c) => {
  // Redirect to the canonical coin list endpoint instead of
  // returning a duplicated /health payload.
  return c.redirect("/api/coins/list", 307);
});

app.get("/coins/list", async (c) => {
  const cacheKey = getCacheKey("coins-list");
  
  // Check cache first
  const cachedData = getCached<{ coins: any[] }>(cacheKey);
  if (cachedData) {
    return c.json(cachedData);
  }

  try {
    // Fetch top 25 coins by market cap
    const url =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false";

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`CoinGecko failed: ${response.status}`);
    }

    const data = await response.json();

    // Return only id, name, and symbol for the dropdown
    const coins = data.map(
      (coin: { id: string; name: string; symbol: string }) => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol.toUpperCase(),
      })
    );

    const result = { coins };
    
    // Cache successful response
    setCache(cacheKey, result, CACHE_TTL_COIN_LIST);
    
    return c.json(result);
  } catch (error) {
    console.warn("Primary coin list failed, trying backup...");
    
    try {
      // Try using the default token list as backup since Coinbase doesn't have a good "top list" endpoint without auth
      // This ensures the dropdown is populated with popular tokens even if CoinGecko fails
      const { TOKEN_LIST_DEFAULT } = await import("@/lib/constants");
      
      // Transform to the expected format
      const coins = TOKEN_LIST_DEFAULT.map((t) => ({
        id: t.id,
        name: t.name,
        symbol: t.symbol
      }));
      
      const result = { coins };
      setCache(cacheKey, result, CACHE_TTL_COIN_LIST);
      return c.json(result);
    } catch (backupError) {
      console.warn("Backup coin list failed");
      
      // On error, try to return cached data even if expired
      const staleCache = cache.get(cacheKey);
      if (staleCache) {
        return c.json(staleCache.data);
      }
      
      return c.json({ error: "Internal server error" }, 500);
    }
  }
});

// Helper function to calculate forecast from price and volatility
function calculateForecast(price: number, volatilityPct: number, direction: number) {
  const volatilityMagnitude = Math.abs(volatilityPct);
  const forecastMultiplier = direction === 1 
    ? 1 + (volatilityMagnitude / 100)
    : 1 - (volatilityMagnitude / 100);
  const forecastMean = price * forecastMultiplier;
  
  const stdDevMultiplier = volatilityMagnitude / 100;
  const forecastLow = forecastMean * (1 - stdDevMultiplier);
  const forecastHigh = forecastMean * (1 + stdDevMultiplier);
  
  return { mean: forecastMean, low: forecastLow, high: forecastHigh };
}

// Optimized backtesting using market_chart API (single call, more reliable)
async function performBacktest(id: string, currentPrice: number, horizonDays: number = 60) {
  try {
    // Use market_chart API to get price data for past N+1 days in a single call
    // This is more efficient and reliable than the history endpoint
    // Returns daily data points automatically
    const daysToFetch = Math.min(horizonDays + 1, 90); // CoinGecko limit is 90 days for free tier
    const chartUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${daysToFetch}`;
    
    const chartResponse = await fetch(chartUrl);
    
    if (!chartResponse.ok) {
      console.warn(`Backtest failed for ${id}: Market chart API returned ${chartResponse.status}`);
      return null;
    }
    
    const chartData = await chartResponse.json();
    const prices = chartData.prices; // Array of [timestamp, price] pairs
    
    if (!prices || prices.length < 2) {
      console.warn(`Backtest failed for ${id}: Insufficient price data`);
      return null;
    }
    
    // Get price from N days ago (or closest available)
    // Prices are sorted by timestamp ascending
    const targetIndex = Math.max(0, prices.length - horizonDays - 1);
    const historicalPrice = prices[targetIndex]?.[1];
    
    // Get price from 24H after historical point to calculate volatility
    const nextDayIndex = Math.min(targetIndex + 1, prices.length - 1);
    const nextDayPrice = prices[nextDayIndex]?.[1];
    
    if (!historicalPrice || !nextDayPrice) {
      console.warn(`Backtest failed for ${id}: Missing price data at target index`);
      return null;
    }
    
    // Calculate 24H volatility at that historical point
    const historicalVolatility = ((nextDayPrice - historicalPrice) / historicalPrice) * 100;
    
    // Calculate what the forecast would have been N days ago
    const historicalDirection = historicalVolatility >= 0 ? 1 : 0;
    const forecastPast = calculateForecast(historicalPrice, historicalVolatility, historicalDirection);
    
    // Calculate accuracy metrics
    const actualPrice = currentPrice;
    const forecastedPrice = forecastPast.mean;
    
    // Absolute Error
    const absoluteError = Math.abs(actualPrice - forecastedPrice);
    
    // Percentage Error
    const percentageError = ((actualPrice - forecastedPrice) / forecastedPrice) * 100;
    
    // Mean Absolute Percentage Error (MAPE)
    const mape = Math.abs(percentageError);
    
    // Check if actual price is within forecast range
    const withinRange = actualPrice >= forecastPast.low && actualPrice <= forecastPast.high;
    
    // Fitness score: inverse of MAPE, normalized to 0-100
    // Lower MAPE = higher fitness
    // Cap MAPE at 100% for fitness calculation
    const cappedMape = Math.min(mape, 100);
    const fitness = Math.max(0, Math.min(100, 100 - cappedMape));
    
    return {
      historicalPrice,
      historicalVolatility,
      forecastPast: {
        mean: forecastPast.mean,
        low: forecastPast.low,
        high: forecastPast.high,
      },
      actualPrice,
      absoluteError,
      percentageError,
      mape,
      withinRange,
      fitness,
      horizon: horizonDays,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`Backtest error for ${id}: ${errorMessage}`);
    return null;
  }
}

// Helper function to fetch from Coinbase as backup
async function fetchFromCoinbase(ticker: string) {
  // Special handling for USDC which usually trades as 1:1 USD and might not have a direct USD trading pair stats
  if (ticker === 'USDC' || ticker === 'USDT' || ticker === 'DAI') {
    // Check if it's a stablecoin request that failed on primary
    // Return pegged values for robustness if API fails for these
    return {
      market_data: {
        current_price: { usd: 1.0 },
        total_volume: { usd: 0 }, // Volume hard to estimate without specific pair
        price_change_percentage_24h: 0
      },
      name: ticker === 'USDC' ? 'USD Coin' : ticker,
      symbol: ticker
    };
  }

  // Use Coinbase Exchange API (public)
  const url = `https://api.exchange.coinbase.com/products/${ticker}-USD/stats`;
  
  const response = await fetch(url);
  
  if (!response.ok) {
    // If USD pair fails, maybe try USDT pair? e.g. ETH-USDT?
    // For now, just throw.
    throw new Error(`Coinbase API failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  // Data format: { open, high, low, volume, last, volume_30day }
  // Note: Volume is in base currency (e.g. BTC), not USD.
  // We approximate USD volume as volume * last price.
  const lastPrice = parseFloat(data.last);
  const openPrice = parseFloat(data.open);
  const volumeBase = parseFloat(data.volume);
  const volumeUsd = volumeBase * lastPrice;
  
  // Volatility: 24h change percentage
  const volatility = ((lastPrice - openPrice) / openPrice) * 100;
  
  // Normalize to CoinGecko structure for consistency
  return {
    market_data: {
      current_price: { usd: lastPrice },
      total_volume: { usd: volumeUsd },
      price_change_percentage_24h: volatility
    },
    name: ticker, // Coinbase doesn't return full name in stats, so we use ticker
    symbol: ticker
  };
}

// Helper function to fetch and process coin data
async function fetchCoinData(input: string, useCache: boolean = true) {
  // Allow any tokenId format - basic validation for non-empty and reasonable length
  if (!input || input.trim().length === 0) {
    throw new Error("Coin ID cannot be empty");
  }
  
  // Prevent extremely long IDs (potential abuse)
  if (input.length > 200) {
    throw new Error("Coin ID is too long");
  }

  // Resolve IDs from input (which could be a ticker or an ID)
  // 1. Check if it's a known ticker in our mapping
  const mappingByTicker = getIdsByTicker(input);
  
  // 2. Check if it's a known CoinGecko ID in our mapping
  const mappingById = getIdsById(input);
  
  // 3. If neither, treat input as the ID (legacy behavior) but assume it's the CoinGecko ID
  //    and try to guess the Coinbase ticker
  const ids = mappingByTicker || mappingById || guessIds(input);
  
  // Use CoinGecko ID as the cache key source for consistency
  const cacheKey = getCacheKey("coin-data", ids.cg);
  
  // Check cache first if enabled
  if (useCache) {
    const cachedData = getCached<any>(cacheKey);
    if (cachedData) {
      return cachedData;
    }
  }
  
  let data;
  let usingBackup = false;
  
  try {
    // Try CoinGecko (Primary) using the resolved CoinGecko ID
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
      ids.cg
    )}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false&vs_currency=usd`;

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        // If 404 and we used a guess, maybe the input was actually a valid ID but our guess was wrong?
        // In this case, we just proceed to backup or fail.
        throw new Error("Coin not found on CoinGecko");
      }
      throw new Error(`CoinGecko failed: ${response.status}`);
    }

    data = await response.json();
  } catch (error) {
    console.warn(`Primary API failed for ${ids.cg} (input: ${input}), trying backup...`);
    
    try {
      // Try Coinbase (Backup) using the resolved Coinbase Ticker
      data = await fetchFromCoinbase(ids.cb);
      usingBackup = true;
    } catch (backupError) {
      console.warn(`Backup API failed for ${ids.cb}`);
      
      // If both fail, try stale cache
      if (useCache) {
        const staleCache = cache.get(cacheKey);
        if (staleCache) {
          return staleCache.data;
        }
      }
      
      // Re-throw the original error or a generic one
      const errorMessage = error instanceof Error ? error.message : "Failed to fetch coin data";
      throw new Error(errorMessage);
    }
  }

  // Extract raw float values from JSON (works for both CoinGecko and normalized CoinCap data)
  const priceUsdFloat = data.market_data?.current_price?.usd ?? null;
  const volumeUsdFloat = data.market_data?.total_volume?.usd ?? null;
  const volPctFloat = data.market_data?.price_change_percentage_24h ?? null;

  // Validate that we have all required data
  if (
    priceUsdFloat === null ||
    volumeUsdFloat === null ||
    volPctFloat === null
  ) {
    throw new Error("Missing required market data");
  }

  // Scale to 1e18 & encode as uint256s
  const SCALE = BigInt("1000000000000000000"); // 10^18
  const ONE_MILLION = BigInt(1000000);

  const priceRaw = BigInt(Math.round(priceUsdFloat * 1e6)) * (SCALE / ONE_MILLION);
  const volumeRaw = BigInt(Math.round(volumeUsdFloat * 1e6)) * (SCALE / ONE_MILLION);

  // Direction: 1 for positive, 0 for negative (determined before taking absolute value)
  const direction = volPctFloat >= 0 ? 1 : 0;

  // Use absolute value for volatility (magnitude only, unsigned)
  const volatilityMagnitude = Math.abs(volPctFloat);
  const volatilityRaw = BigInt(Math.round(volatilityMagnitude * 1e6)) * (SCALE / ONE_MILLION);

  // Calculate forecast using helper function
  const forecast = calculateForecast(priceUsdFloat, volPctFloat, direction);
  const forecastMeanRaw = BigInt(Math.round(forecast.mean * 1e6)) * (SCALE / ONE_MILLION);
  const forecastLowRaw = BigInt(Math.round(forecast.low * 1e6)) * (SCALE / ONE_MILLION);
  const forecastHighRaw = BigInt(Math.round(forecast.high * 1e6)) * (SCALE / ONE_MILLION);

  // Perform 7-day backtesting (only if using primary API, or if we implement backup backtest)
  // If using backup, backtest will likely fail on CoinGecko anyway, so we skip it or let it return null
  let backtest = null;
  if (!usingBackup) {
    backtest = await performBacktest(ids.cg, priceUsdFloat);
  }
  
  // Calculate fitnessRaw - default to 0 if backtest fails (never use null for numeric values)
  let fitnessRaw: string = "0";
  if (backtest && backtest.fitness !== null && !isNaN(backtest.fitness)) {
    // Fitness is 0-100, scale to 1e18 for uint256
    const fitnessScaled = BigInt(Math.round(backtest.fitness * 1e16)); // 100 * 1e16 = 1e18 when fitness = 100
    fitnessRaw = fitnessScaled.toString();
  }

  const result = {
    price: priceUsdFloat,
    volume: volumeUsdFloat,
    volatility: volPctFloat,
    priceRaw: priceRaw.toString(),
    volumeRaw: volumeRaw.toString(),
    volatilityRaw: volatilityRaw.toString(),
    forecast: {
      mean: forecast.mean,
      low: forecast.low,
      high: forecast.high,
    },
    forecastRaw: {
      mean: forecastMeanRaw.toString(),
      low: forecastLowRaw.toString(),
      high: forecastHighRaw.toString(),
    },
    backtest: backtest,
    fitnessRaw: fitnessRaw,
    direction: direction,
    name: data.name || ids.cg,
    symbol: data.symbol?.toUpperCase() || "",
    lastUpdated: new Date().toISOString(),
    source: usingBackup ? "coinbase" : "coingecko"
  };
  
  // Cache successful response if enabled
  if (useCache) {
    setCache(cacheKey, result, CACHE_TTL_COIN_DATA);
  }
  
  return result;
}

// Endpoint with all data (original response)
app.get("/features/all/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const coinData = await fetchCoinData(id);

    // Format fitness as a number with 2 decimal places (like price/volume)
    // Default to 0 if backtest fails (never use null for numeric values)
    const fitnessValue = coinData.backtest?.fitness;
    const fitnessFormatted = fitnessValue !== null && fitnessValue !== undefined && !isNaN(fitnessValue)
      ? parseFloat(fitnessValue.toFixed(2))
      : 0;

    return c.json({
      // Original float values for display
      price: coinData.price,
      volume: coinData.volume,
      volatility: coinData.volatility,
      forecast: coinData.forecast,
      fitness: fitnessFormatted,
      direction: coinData.direction,
      backtest: coinData.backtest,
      name: coinData.name,
      symbol: coinData.symbol,
      lastUpdated: coinData.lastUpdated,
      source: coinData.source,
    });
  } catch (error) {
    // On error, try to return cached data
    const cacheKey = getCacheKey("coin-data", id);
    const staleCache = cache.get(cacheKey);
    if (staleCache) {
      const coinData = staleCache.data;
      const fitnessValue = coinData.backtest?.fitness;
      const fitnessFormatted = fitnessValue !== null && fitnessValue !== undefined && !isNaN(fitnessValue)
        ? parseFloat(fitnessValue.toFixed(2))
        : 0;
      
      return c.json({
        price: coinData.price,
        volume: coinData.volume,
        volatility: coinData.volatility,
        forecast: coinData.forecast,
        fitness: fitnessFormatted,
        direction: coinData.direction,
        backtest: coinData.backtest,
        name: coinData.name,
        symbol: coinData.symbol,
        lastUpdated: coinData.lastUpdated,
        source: coinData.source,
      });
    }
    
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    const statusCode = errorMessage.includes("not found")
      ? 404
      : errorMessage.includes("Invalid")
      ? 400
      : 500;
    return c.json({ error: errorMessage }, statusCode);
  }
});

// Smart contract endpoint - only uint256 values
app.get("/features/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const coinData = await fetchCoinData(id);

    // Return uint256-encoded values and direction for smart contract integration
    // All values are unsigned uint256 strings for Solidity compatibility
    // Includes naive forecast as sanity check and backtest fitness
    return c.json({
      price: coinData.priceRaw,
      volume: coinData.volumeRaw,
      volatility: coinData.volatilityRaw,
      direction: coinData.direction,
      forecast: coinData.forecastRaw,
      fitness: coinData.fitnessRaw,
    });
  } catch (error) {
    // On error, try to return cached data
    const cacheKey = getCacheKey("coin-data", id);
    const staleCache = cache.get(cacheKey);
    if (staleCache) {
      const coinData = staleCache.data;
      return c.json({
        price: coinData.priceRaw,
        volume: coinData.volumeRaw,
        volatility: coinData.volatilityRaw,
        direction: coinData.direction,
        forecast: coinData.forecastRaw,
        fitness: coinData.fitnessRaw,
      });
    }
    
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    const statusCode = errorMessage.includes("not found")
      ? 404
      : errorMessage.includes("Invalid")
      ? 400
      : 500;
    return c.json({ error: errorMessage }, statusCode);
  }
});

// Price-only endpoint returning uint256 string
app.get("/price/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const coinData = await fetchCoinData(id);
    
    // Return only the uint256 price string
    return c.json({
      price: coinData.priceRaw
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    const statusCode = errorMessage.includes("not found")
      ? 404
      : errorMessage.includes("Invalid")
      ? 400
      : 500;
    return c.json({ error: errorMessage }, statusCode);
  }
});

app.get("/:wild", (c) => {
  const wild = c.req.param("wild");
  return c.json({
    message: `gRitual ❖`,
  });
});

export const GET = handle(app);
