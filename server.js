const express = require('express')
const app = express()

const PORT  = process.env.PORT  || 8080
const TOKEN = process.env.PROP_SERVER_TOKEN  // optional — set in Railway env vars

const MLB_GROUP_ID = 84240
const CACHE_TTL_MS = 15 * 60 * 1000  // 15 minutes

// In-memory cache — resets on server restart (Railway keeps it running continuously)
let propCache = { data: null, expiry: 0 }

// ── Auth ──────────────────────────────────────────────────────────────────────
// If PROP_SERVER_TOKEN is set in Railway env vars, every request must include
// x-api-token: <token> header. Keeps random people off your server.
app.use((req, res, next) => {
  if (TOKEN && req.headers['x-api-token'] !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cached: propCache.expiry > Date.now(),
    cacheExpiresIn: Math.max(0, Math.round((propCache.expiry - Date.now()) / 1000)) + 's'
  })
})

app.get('/props/mlb', async (req, res) => {
  try {
    if (Date.now() < propCache.expiry && propCache.data) {
      console.log('Serving MLB props from cache')
      return res.json(propCache.data)
    }

    console.log('Fetching fresh MLB props from DraftKings...')
    const props = await fetchMLBProps()
    propCache = { data: props, expiry: Date.now() + CACHE_TTL_MS }
    console.log(`Cached ${props.length} props`)
    res.json(props)
  } catch (err) {
    console.error('Error fetching MLB props:', err.message)
    // Return stale cache rather than an error if available
    if (propCache.data) {
      console.log('Returning stale cache after error')
      return res.json(propCache.data)
    }
    res.status(502).json({ error: err.message })
  }
})

// ── DraftKings fetcher ────────────────────────────────────────────────────────

const DK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://sportsbook.draftkings.com',
  'Referer': 'https://sportsbook.draftkings.com/'
}

async function fetchMLBProps() {
  // Step 1: get event list + offer category IDs
  const groupRes = await fetch(
    `https://sportsbook.draftkings.com/sites/US-SB/api/v5/eventgroups/${MLB_GROUP_ID}?includeEventGroupLeague=true`,
    { headers: DK_HEADERS }
  )
  if (!groupRes.ok) throw new Error(`DraftKings event group HTTP ${groupRes.status}`)
  const groupData = await groupRes.json()

  const events     = groupData.eventGroup?.events          || []
  const categories = groupData.eventGroup?.offerCategories || []

  const propCatIds = categories
    .filter(c => isPropCategory(c.name))
    .map(c => c.offerCategoryId)

  console.log(`Found ${events.length} events, ${propCatIds.length} prop categories: ${propCatIds.join(', ')}`)
  if (propCatIds.length === 0) return []

  // Step 2: fetch each prop category (usually 2: batter props + pitcher props)
  const allProps = []
  for (const catId of propCatIds) {
    await sleep(400)
    try {
      const catRes = await fetch(
        `https://sportsbook.draftkings.com/sites/US-SB/api/v5/eventgroups/${MLB_GROUP_ID}/categories/${catId}`,
        { headers: DK_HEADERS }
      )
      if (!catRes.ok) {
        console.warn(`Category ${catId} returned HTTP ${catRes.status}`)
        continue
      }
      const catData = await catRes.json()
      const props = parseCategory(catData, events)
      console.log(`Category ${catId}: ${props.length} props`)
      allProps.push(...props)
    } catch (e) {
      console.warn(`Failed fetching category ${catId}:`, e.message)
    }
  }

  return allProps
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function isPropCategory(name) {
  if (!name) return false
  const l = name.toLowerCase()
  return l.includes('batter') || l.includes('pitcher') || l.includes('player prop') || l.includes('hitter')
}

function parseCategory(data, events) {
  const props = []
  const categories = data.eventGroup?.offerCategories || []

  for (const cat of categories) {
    for (const subcat of (cat.offerSubcategoryDescriptors || [])) {
      const propType = propTypeForSubcategory(subcat.name)
      if (!propType) continue

      for (const offerPair of (subcat.offers || [])) {
        const over  = offerPair.find(o => o.label?.toLowerCase() === 'over')
        const under = offerPair.find(o => o.label?.toLowerCase() === 'under')
        if (!over || !under) continue

        const playerName = over.participant || over.playerName
        const line       = over.line
        if (!playerName || line == null) continue

        // Skip suspended markets
        if (over.isSuspended || under.isSuspended) continue

        const dkEventId = over.eventId ?? offerPair.find(o => o.eventId)?.eventId
        const event     = events.find(e => e.eventId === dkEventId)

        props.push({
          id:          `${dkEventId ?? 0}_${playerName}_${propType}`,
          dkEventId:   dkEventId ?? 0,
          dkHomeTeam:  event?.teamName1 || '',
          dkAwayTeam:  event?.teamName2 || '',
          playerName,
          propType,
          line,
          overOdds:    parseOdds(over.oddsAmerican),
          underOdds:   parseOdds(under.oddsAmerican),
          bookmaker:   'draftkings'
        })
      }
    }
  }

  return props
}

function propTypeForSubcategory(name) {
  if (!name) return null
  const l = name.toLowerCase()
  if (l.includes('strikeout'))                         return 'Pitcher Strikeouts'
  if (l === 'hits' || l.startsWith('hits ('))          return 'Batter Hits'
  if (l.includes('hits') && !l.includes('home'))       return 'Batter Hits'
  if (l.includes('home run'))                          return 'Home Runs'
  if (l.includes('total base'))                        return 'Total Bases'
  if (l.includes('rbi') || l.includes('runs batted')) return 'RBIs'
  if (l.includes('earned run'))                        return 'Earned Runs Allowed'
  return null
}

function parseOdds(str) {
  if (!str) return -110
  return parseInt(str.replace('+', ''), 10) || -110
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SportsProps server running on port ${PORT}`)
  console.log(`Auth token: ${TOKEN ? 'ENABLED' : 'disabled (set PROP_SERVER_TOKEN to enable)'}`)
})
