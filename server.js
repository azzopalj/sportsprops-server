const express = require('express')
const app = express()

const PORT  = process.env.PORT  || 8080
const TOKEN = process.env.PROP_SERVER_TOKEN

const CACHE_TTL_MS = 15 * 60 * 1000  // 15 minutes

let propCache = { data: null, expiry: 0 }

// ── Auth ──────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  // /health is always public so the app can check server status
  if (req.path === '/health') return next()
  if (TOKEN && req.headers['x-api-token'] !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — check your server token in Settings' })
  }
  next()
})

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    source: 'prizepicks',
    cached: propCache.expiry > Date.now(),
    propCount: propCache.data?.length ?? 0,
    cacheExpiresIn: Math.max(0, Math.round((propCache.expiry - Date.now()) / 1000)) + 's'
  })
})

app.get('/props/mlb', async (req, res) => {
  try {
    if (Date.now() < propCache.expiry && propCache.data) {
      console.log(`Serving ${propCache.data.length} props from cache`)
      return res.json(propCache.data)
    }

    console.log('Fetching fresh MLB props from PrizePicks...')
    const props = await fetchPrizePicksMLB()
    propCache = { data: props, expiry: Date.now() + CACHE_TTL_MS }
    console.log(`Cached ${props.length} MLB props`)
    res.json(props)
  } catch (err) {
    console.error('Error:', err.message)
    // Return stale cache on error rather than failing
    if (propCache.data) {
      console.log('Returning stale cache')
      return res.json(propCache.data)
    }
    res.status(502).json({ error: err.message })
  }
})

// ── PrizePicks fetcher ────────────────────────────────────────────────────────
// PrizePicks API is public, no auth, no geo-blocking, works from any server IP.
// MLB league_id = 2. Lines are posted each morning for the day's games.

async function fetchPrizePicksMLB() {
  const url = 'https://api.prizepicks.com/projections?league_id=2&per_page=250&single_stat=true&game_mode=true'
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }
  })

  if (!res.ok) throw new Error(`PrizePicks HTTP ${res.status}`)
  const body = await res.json()

  // Build player lookup from included[]
  const playerMap = {}
  for (const item of (body.included || [])) {
    if (item.type === 'new_player') {
      playerMap[item.id] = item.attributes
    }
  }

  const props = []
  for (const item of (body.data || [])) {
    if (item.type !== 'projection') continue
    const attr = item.attributes

    // Skip non-pregame and non-normal projections
    if (attr.status && attr.status !== 'pre_game') continue
    if (attr.projection_type && attr.projection_type !== 'normal') continue

    const propType = mapStatType(attr.stat_type)
    if (!propType) continue

    const line = parseFloat(attr.line_score)
    if (isNaN(line)) continue

    // Player name — prefer from included, fall back to attr.player_name
    const playerId = item.relationships?.new_player?.data?.id
    const playerAttr = playerId ? playerMap[playerId] : null
    const playerName = playerAttr?.name || attr.player_name
    if (!playerName) continue

    // Team names from description (e.g. "NYY Yankees vs BOS Red Sox" or "Yankees vs Red Sox")
    const description = attr.description || ''
    const [homeTeam, awayTeam] = parseTeams(description)

    props.push({
      id:          `pp_${item.id}`,
      dkEventId:   0,
      dkHomeTeam:  homeTeam,
      dkAwayTeam:  awayTeam,
      playerName,
      propType,
      line,
      overOdds:    -115,   // PrizePicks uses flat juice
      underOdds:   -115,
      bookmaker:   'prizepicks'
    })
  }

  return props
}

// PrizePicks stat_type → our PropType rawValue (must match Swift enum exactly)
function mapStatType(statType) {
  if (!statType) return null
  const s = statType.toLowerCase().trim()
  if (s === 'strikeouts' || s === 'pitcher strikeouts') return 'Pitcher Strikeouts'
  if (s === 'hits')                                      return 'Batter Hits'
  if (s === 'total bases')                               return 'Total Bases'
  if (s === 'home runs')                                 return 'Home Runs'
  if (s === 'rbis' || s === 'rbi')                       return 'RBIs'
  if (s.includes('earned run'))                          return 'Earned Runs Allowed'
  return null
}

// Parse "Away @ Home" or "Away vs Home" from PrizePicks description
function parseTeams(description) {
  const parts = description.split(/\s+(?:@|vs\.?)\s+/i)
  if (parts.length === 2) {
    return [parts[1].trim(), parts[0].trim()]  // [home, away]
  }
  return ['', '']
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SportsProps server on port ${PORT}`)
  console.log(`Auth: ${TOKEN ? 'enabled' : 'disabled'}`)
})
