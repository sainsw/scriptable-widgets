// Toyota: a Scriptable widget (https://scriptable.app) showing your car from
// the MyToyota app: how much charge or fuel it has and how far that gets
// you, whether it's locked and anything left open, and the mileage.
//
// Toyota has no widgets or public API, so this talks to the MyToyota app's
// own backend (Toyota Connected Europe) the way pytoyoda does
// (https://github.com/pytoyoda/pytoyoda), which is where to look when it
// breaks: Toyota moves these endpoints now and then. Setup:
//   1. Run the script once in Scriptable and log in with your MyToyota email
//      and password. They're kept in the iOS Keychain, not in this file,
//      and only used to log in again if Toyota's session lapses.
//      Running it in the app also offers to save where the car's parked
//      as home, so the widget says "Parked at home" rather than the street.
//   2. Add a Scriptable widget, long-press it → Edit Widget → pick this script.
//      Give it the parameter "trips" for the last drive and this month's
//      driving instead of the charge.

const UNITS = "mi" // "mi" or "km"
const VIN = "" // which car, if the account has more than one; blank for the first
const LOGIN_KEY = "toyota_widget_login"
const TOKEN_KEY = "toyota_widget_tokens"
const HOME_KEY = "toyota_widget_home"

// The MyToyota app's own client details, as pytoyoda uses them.
const AUTH = "https://b2c-login.toyota-europe.com"
const REALM = `${AUTH}/json/realms/root/realms/tme`
const OAUTH = `${AUTH}/oauth2/realms/root/realms/tme`
const REDIRECT = "com.toyota.oneapp:/oauth2Callback"
const BASIC = "basic b25lYXBwOm9uZWFwcA=="
const API = "https://ctpa-oneapi.tceu-ctp-prd.toyotaconnectedeurope.io"
const API_KEY = "tTZipv6liF74PwMfk9Ed68AQ0bISswwf3iHQdqcF"
const APP_VERSION = "2.14.0"
// Opens the MyToyota app, which answers to its login redirect's scheme.
const APP_URL = "com.toyota.oneapp://"

// ---------------------------------------------------------------------------
// Logging in

const saved = (key) => Keychain.contains(key) ? JSON.parse(Keychain.get(key)) : null
const save = (key, value) => Keychain.set(key, JSON.stringify(value))

// Thrown when only a person can fix it: the login needs typing in again.
class NeedsLogin extends Error {}

async function login() {
  const kept = saved(LOGIN_KEY)
  if (kept) return kept
  if (config.runsInWidget) throw new NeedsLogin("Run the script in Scriptable to log in")
  const a = new Alert()
  a.title = "MyToyota login"
  a.message = "Kept in the iOS Keychain on this phone, and only sent to Toyota."
  a.addTextField("Email")
  a.addSecureTextField("Password")
  a.addAction("Log in")
  a.addCancelAction("Cancel")
  if ((await a.present()) === -1) throw new Error("Not logged in")
  const l = { username: a.textFieldValue(0).trim(), password: a.textFieldValue(1) }
  save(LOGIN_KEY, l)
  return l
}

// Toyota's login is ForgeRock: post to it until it has asked for everything
// it wants (locale first, which is left blank, then the email and password)
// and hands back a session, then trade that for an OAuth code, and the code
// for tokens.
async function signIn() {
  const l = await login()
  let data = {}
  for (let i = 0; i < 10 && !data.tokenId; i++) {
    for (const cb of data.callbacks ?? []) {
      const prompt = cb.output?.[0]?.value
      if (cb.type === "NameCallback" && prompt === "User Name") cb.input[0].value = l.username
      else if (cb.type === "PasswordCallback") cb.input[0].value = l.password
      else if (cb.type === "TextOutputCallback" && prompt === "User Not Found") {
        Keychain.remove(LOGIN_KEY)
        throw new NeedsLogin("Toyota doesn't know that email")
      }
    }
    const req = new Request(`${REALM}/authenticate?authIndexType=service&authIndexValue=oneapp`)
    req.method = "POST"
    req.headers = { "Content-Type": "application/json" }
    req.body = JSON.stringify(data)
    data = await req.loadJSON()
    if (req.response.statusCode === 401) {
      Keychain.remove(LOGIN_KEY)
      throw new NeedsLogin("Wrong MyToyota email or password")
    }
    if (req.response.statusCode !== 200) throw new Error(`Toyota login returned ${req.response.statusCode}`)
  }
  if (!data.tokenId) throw new Error("Toyota login didn't finish")

  // The code comes back in a redirect to the app, which is caught rather
  // than followed.
  const auth = new Request(`${OAUTH}/authorize?client_id=oneapp&scope=openid+profile+write&response_type=code` +
    `&redirect_uri=${REDIRECT}&code_challenge=plain&code_challenge_method=plain`)
  auth.headers = { Cookie: `iPlanetDirectoryPro=${data.tokenId}` }
  let code
  auth.onRedirect = (r) => {
    code = r.url.match(/[?&]code=([^&]+)/)?.[1]
    return code ? null : r
  }
  try { await auth.load() } catch {}
  code ??= headerValue(auth.response?.headers, "location")?.match(/[?&]code=([^&]+)/)?.[1]
  if (!code) throw new Error("Toyota login gave no code")
  return tokens({ grant_type: "authorization_code", code })
}

// Trades a code or a refresh token for new tokens, and keeps them.
async function tokens(grant) {
  const req = new Request(`${OAUTH}/access_token`)
  req.method = "POST"
  req.headers = { Authorization: BASIC, "Content-Type": "application/x-www-form-urlencoded" }
  req.body = Object.entries({ client_id: "oneapp", redirect_uri: REDIRECT, code_verifier: "plain", ...grant })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
  const res = await req.loadJSON()
  if (req.response.statusCode !== 200 || !res.access_token) throw new Error(`Toyota tokens returned ${req.response.statusCode}`)
  // The account's ID is in the ID token, which is a JWT.
  const claims = JSON.parse(Data.fromBase64String(base64(res.id_token.split(".")[1])).toRawString())
  const t = { access: res.access_token, refresh: res.refresh_token, uuid: claims.uuid,
              expires: Date.now() + (res.expires_in - 60) * 1000 }
  save(TOKEN_KEY, t)
  return t
}

// A session that works: the kept one, refreshed, or a new login.
async function session(force) {
  const t = saved(TOKEN_KEY)
  if (t && !force && t.expires > Date.now()) return t
  if (t?.refresh) {
    try { return await tokens({ grant_type: "refresh_token", refresh_token: t.refresh }) } catch {}
  }
  return signIn()
}

const base64 = (s) => s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")
const headerValue = (headers, name) => headers && headers[Object.keys(headers).find((k) => k.toLowerCase() === name)]

// ---------------------------------------------------------------------------
// The app also sends an HMAC-SHA256 of the account ID, keyed with its
// version. Scriptable has no crypto, so here's SHA-256.

const bytes = (s) => [...unescape(encodeURIComponent(s))].map((c) => c.charCodeAt(0))
const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0
const PRIMES = [...Array(312).keys()].filter((n) => n > 1 && [...Array(n).keys()].slice(2).every((d) => n % d)).slice(0, 64)
const K = PRIMES.map((p) => frac(Math.cbrt(p)))
const H0 = PRIMES.slice(0, 8).map((p) => frac(Math.sqrt(p)))

function sha256(msg) {
  const m = [...msg, 0x80]
  while (m.length % 64 !== 56) m.push(0)
  const bits = msg.length * 8
  for (let i = 7; i >= 0; i--) m.push(i > 3 ? 0 : (bits >>> (i * 8)) & 255)
  const h = [...H0]
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let o = 0; o < m.length; o += 64) {
    const w = []
    for (let i = 0; i < 64; i++) {
      if (i < 16) w[i] = (m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3]
      else {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
      }
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      ;[hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0]
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) | 0 })
  }
  return h.flatMap((v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
}

function hmacSha256(key, msg) {
  let k = bytes(key)
  if (k.length > 64) k = sha256(k)
  k = [...k, ...Array(64 - k.length).fill(0)]
  const inner = sha256([...k.map((b) => b ^ 0x36), ...bytes(msg)])
  return sha256([...k.map((b) => b ^ 0x5c), ...inner]).map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ---------------------------------------------------------------------------
// The car

async function api(path, vin, retried) {
  const t = await session(retried)
  const req = new Request(`${API}${path}`)
  req.headers = {
    "x-api-key": API_KEY, API_KEY,
    "x-guid": t.uuid, guid: t.uuid,
    "x-client-ref": hmacSha256(APP_VERSION, t.uuid),
    "x-correlationid": UUID.string().toLowerCase(),
    "x-appversion": APP_VERSION,
    "x-channel": "ONEAPP",
    "x-brand": "T",
    "x-region": "EU", "x-user-region": "EU",
    Authorization: `Bearer ${t.access}`,
    "User-Agent": "okhttp/4.10.0",
    ...(vin ? { vin } : {}),
  }
  const res = await req.loadJSON().catch(() => null)
  const status = req.response?.statusCode
  // A session Toyota has dropped early: log in again, once.
  if (status === 401 && !retried) return api(path, vin, true)
  if (status !== 200) throw new Error(`Toyota ${path} returned ${status ?? "nothing"}`)
  return res?.payload
}

// The car's details and picture hardly change, so they're kept for a day.
async function car(fm, dir) {
  const file = fm.joinPath(dir, "car.json")
  const kept = fm.fileExists(file) ? JSON.parse(fm.readString(file)) : null
  if (kept && "carline" in kept && Date.now() - kept.at < 86400e3) return kept
  const cars = await api("/v2/vehicle/guid")
  const c = cars?.find((v) => !VIN || v.vin === VIN)
  if (!c) throw new Error(VIN ? `No car with VIN ${VIN}` : "No cars on this MyToyota account")
  const info = { at: Date.now(), vin: c.vin, nickname: c.nickName, carline: c.carlineName ?? null,
                 model: c.displayModelDescription, fuelType: c.fuelType, ev: c.evVehicle, image: c.image }
  if (info.image) {
    try { fm.writeImage(fm.joinPath(dir, "car.png"), await new Request(info.image).loadImage()) } catch {}
  }
  fm.writeString(file, JSON.stringify(info))
  return info
}

// Everything the widget shows, with the car's reports kept on the phone:
// if Toyota can't be reached, the last ones are shown, marked as such.
async function loadOrCached() {
  const fm = FileManager.local()
  const dir = fm.joinPath(fm.documentsDirectory(), Script.name())
  if (!fm.fileExists(dir)) fm.createDirectory(dir)
  const cache = fm.joinPath(dir, "status.json")
  try {
    const c = await car(fm, dir)
    // Plug-in hybrids (I) and electric cars (E) also report their battery.
    const plugs = c.ev || c.fuelType === "E" || c.fuelType === "I"
    // Trips from the start of the month, or the last 30 days if that's
    // longer, so there's a last drive even early in the month. Only the
    // latest trip is wanted; the month's totals come with it.
    const now = new Date()
    const from = new Date(Math.min(new Date(now.getFullYear(), now.getMonth(), 1), now - 30 * 86400e3))
    const [telemetry, status, electric, location, trips] = await Promise.all([
      api("/v3/telemetry", c.vin).catch(() => null),
      api("/v1/vehicle/status", c.vin).catch(() => null),
      plugs ? api("/v1/vehicle/electric/status", c.vin).catch(() => null) : null,
      api("/v1/location", c.vin).catch(() => null),
      api(`/v1/trips?from=${ymd(from)}&to=${ymd(now)}&route=false&summary=true&limit=1&offset=0`, c.vin).catch(() => null),
    ])
    if (!telemetry && !status && !electric) throw new Error("Toyota sent nothing back for the car")
    const kept = fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : null
    const d = { car: c, telemetry, status, electric, location, trips, fetchedAt: Date.now() }
    d.place = await place(d.location?.vehicleLocation, kept?.place)
    fm.writeString(cache, JSON.stringify(d))
    return { ...d, picture: picture(fm, dir) }
  } catch (e) {
    if (!fm.fileExists(cache)) throw e
    const d = JSON.parse(fm.readString(cache))
    return { ...d, picture: picture(fm, dir), warning: e instanceof NeedsLogin ? "Log in to Toyota again" : "Can't reach Toyota" }
  }
}

// The car's nickname, or its model when it hasn't been given one: Toyota
// fills the nickname in with the VIN until it is.
function carName(c) {
  const vin = (n) => n === c.vin || /^[A-HJ-NPR-Z0-9]{17}$/i.test(n)
  return [c.nickname ?? c.name, c.carline, c.model].find((n) => n && !vin(n)) ?? "Toyota"
}

function picture(fm, dir) {
  const p = fm.joinPath(dir, "car.png")
  return fm.fileExists(p) ? fm.readImage(p) : null
}

const ymd = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`

// The street the car's parked on, looked up from where Toyota says it is.
// Kept with the reports, and only looked up again once the car's moved.
async function place(loc, kept) {
  if (!loc) return null
  if (kept && metres(kept, { lat: loc.latitude, lon: loc.longitude }) < 30) return kept
  try {
    const [p] = await Location.reverseGeocode(loc.latitude, loc.longitude, "en_GB")
    return { lat: loc.latitude, lon: loc.longitude, street: p?.thoroughfare ?? null,
             area: p?.subLocality ?? p?.locality ?? null }
  } catch {
    return kept ?? null
  }
}

// Near enough for the distances here: how far apart two spots are, in metres.
function metres(a, b) {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad)
  return Math.hypot(x, (b.lat - a.lat) * rad) * 6371e3
}

// ---------------------------------------------------------------------------
// What to show

const toUnits = (v) => {
  if (v?.value == null) return null
  const km = v.unit === "mi" ? v.value * 1.609344 : v.value
  return UNITS === "mi" ? km / 1.609344 : km
}
const distance = (v) => v == null ? null : `${Math.round(v).toLocaleString("en-GB")} ${UNITS}`

// The headline: battery for cars you plug in, fuel otherwise, with range and
// whether it's charging.
function level(d) {
  const e = d.electric, t = d.telemetry
  const plugs = d.car.fuelType === "E" || d.car.fuelType === "I" || d.car.ev
  // A plug-in hybrid keeps some of its battery back for the hybrid system,
  // and reports the part you can drive on separately; that's the one the
  // MyToyota app shows.
  const battery = (d.car.fuelType === "I" ? e?.phevUsableBatteryLevel : null) ?? e?.batteryLevel ?? t?.batteryLevel
  const status = (e?.chargingStatus ?? t?.chargingStatus ?? "").toLowerCase()
  const charging = status === "charging"
  // Toyota sends 65535 or thereabouts for "not charging".
  const minutes = e?.remainingChargeTime
  const left = charging && minutes > 0 && minutes <= 1440 ? minutes : null
  if (plugs && battery != null) {
    return {
      kind: "battery", percent: battery, charging,
      plugged: charging || /plug|connect|wait|complete/.test(status),
      range: toUnits(e?.evRange ?? (d.car.fuelType === "E" ? t?.distanceToEmpty : null)),
      left,
      // A plug-in hybrid has fuel too, and a range on both together: the
      // car's own figure for that, or failing it the two ranges added up.
      fuel: d.car.fuelType === "I" ? { percent: e?.fuelLevel ?? t?.fuelLevel, range: toUnits(e?.fuelRange) } : null,
      total: d.car.fuelType === "I"
        ? toUnits(t?.distanceToEmpty) ?? (e?.evRange && e?.fuelRange ? toUnits(e.evRange) + toUnits(e.fuelRange) : null)
        : null,
    }
  }
  return { kind: "fuel", percent: t?.fuelLevel ?? e?.fuelLevel, range: toUnits(t?.distanceToEmpty ?? e?.fuelRange) }
}

const DOORS = { driver: "Driver's door", passenger: "Passenger door", rearLeft: "Rear left door",
                rearRight: "Rear right door", rearBack: "Boot", hood: "Bonnet" }

// Locked or not, and anything open.
function security(d) {
  const s = d.status
  if (!s) return null
  const doors = Object.entries(s.doors ?? {})
  const locks = doors.filter(([k]) => k !== "hood").map(([, v]) => v?.lockStatus?.status).filter(Boolean)
  const open = [
    ...doors.filter(([, v]) => v?.openStatus?.status === "open").map(([k]) => DOORS[k] ?? "A door"),
    ...Object.values(s.windows ?? {}).filter((w) => w?.status === "open").map(() => "Window"),
  ]
  const windows = open.filter((o) => o === "Window").length
  const named = [...open.filter((o) => o !== "Window"), ...(windows ? [windows > 1 ? `${windows} windows` : "A window"] : [])]
  return {
    locked: locks.length ? locks.every((l) => l === "locked") : null,
    open: named,
    summary: named.length ? `${named[0]}${named.length > 1 ? ` +${named.length - 1}` : ""} open` : "All shut",
  }
}

// When the car last reported, which isn't the same as when this last ran:
// a parked car doesn't report.
function reported(d) {
  const times = [d.telemetry?.timestamp, d.status?.lastUpdateTimestamp, d.electric?.lastUpdateTimestamp]
    .filter(Boolean).map((t) => new Date(t).getTime())
  return times.length ? when(Math.max(...times)) : null
}

// A time as just the time today, or with the day before that.
function when(time) {
  const t = new Date(time)
  return t.toDateString() === new Date().toDateString()
    ? t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })
}

// Where it's parked: home, when it's near the spot saved as home, or the
// street. short is for the tiles, where "Parked" is already the label.
function parked(d) {
  const p = d.place
  if (!p) return null
  const home = saved(HOME_KEY)
  const since = d.location?.vehicleLocation?.locationAcquisitionDatetime
  if (home && metres(home, p) < 150) return { home: true, text: "Parked at home", short: "Home", since }
  if (p.street) return { home: false, text: `Parked on ${p.street}`, short: p.street, since }
  if (p.area) return { home: false, text: `Parked in ${p.area}`, short: p.area, since }
  return null
}

// The last drive and this month's driving, from Toyota's trips: lengths
// in metres, and fuel in millilitres. ev is the share driven on
// electric, when the car says (hybrids do).
function driving(d) {
  const t = d.trips
  if (!t) return null
  const now = new Date(d.fetchedAt)
  const trip = (s, hdc) => ({
    distance: toUnits({ value: s.length / 1000, unit: "km" }),
    ev: hdc && s.length ? Math.min(1, hdc.evDistance / s.length) : null,
    economy: economy(s.length, s.fuelConsumption),
  })
  const last = t.trips?.[0]
  const month = t.summary?.find((m) => m.year === now.getFullYear() && m.month === now.getMonth() + 1)
  return {
    monthName: now.toLocaleString("en-GB", { month: "long" }),
    month: month ? trip(month.summary, month.hdc) : null,
    last: last && {
      ...trip(last.summary, last.hdc),
      minutes: Math.round(last.summary.duration / 60),
      ended: last.summary.endTs,
      score: last.scores?.global ?? null,
    },
  }
}

// mpg in miles, litres per 100 km in kilometres; none for a drive that
// used no fuel.
function economy(m, ml) {
  if (!ml || !m) return null
  return UNITS === "mi" ? `${Math.round(m / 1609.344 / (ml / 4546.09))} mpg` : `${(ml / 1000 / (m / 100e3)).toFixed(1)} L/100km`
}

// 66% electric, or all of it.
const electricShare = (ev, short) => ev == null ? null
  : ev >= 0.995 ? (short ? "all EV" : "all electric")
  : ev < 0.005 ? "no EV" : `${Math.round(ev * 100)}% ${short ? "EV" : "electric"}`

// A drive's length: to a tenth under ten, since most drives are short.
const tripDistance = (v) => v == null ? null : v < 10 ? `${v.toFixed(1)} ${UNITS}` : distance(v)

const hm = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`

// ---------------------------------------------------------------------------
// Drawing

// Widget sizes in points, which Scriptable doesn't give, from Apple's table
// of them by the phone's screen width: the small's side, the medium's and
// large's width, and the large's height. The nearest screen is used for
// phones newer than the table. The 402 point screen's widgets measure
// 350 by 364 on the home screen, not the table's 344 by 366, so that's
// what's here.
const WIDGET = (() => {
  const sizes = [[440, 170, 364, 382], [430, 170, 364, 382], [428, 170, 364, 382], [414, 169, 360, 379],
                 [402, 162, 350, 364], [393, 158, 338, 354], [390, 158, 338, 354], [375, 155, 329, 345],
                 [360, 155, 329, 345], [320, 141, 292, 311]]
  const { width, height } = Device.screenSize()
  const screen = Math.min(width, height)
  const [, small, wide, large] = sizes.reduce((a, b) => Math.abs(b[0] - screen) < Math.abs(a[0] - screen) ? b : a)
  return { small, width: wide, large }
})()

const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark))
const BG = dyn("#FFFFFF", "#1C1C1E")
const PRIMARY = dyn("#000000", "#FFFFFF")
const SECONDARY = dyn("#8A8A8E", "#98989F")
const GREEN = dyn("#248A3D", "#30D158")
const ORANGE = dyn("#C93400", "#FF9F0A")
const RED = dyn("#D70015", "#FF453A")
const TOYOTA = dyn("#EB0A1E", "#FF3B45")
// Apple's system blue and a warm amber, for the small widget's lock and
// house, coloured like the Apple Watch's own.
const BLUE = dyn("#007AFF", "#0A84FF")
const AMBER = dyn("#E8A200", "#FFC233")

// Calm unless it matters: green while charging, orange when low, red when
// nearly empty.
// What the big number shows. Usually the level, but a plug-in hybrid with
// nothing left in the usable battery is just driving as a hybrid, so then
// it's the fuel, until it's charging again.
function shown(l) {
  const onFuel = l.kind === "fuel" || (l.fuel?.percent != null && l.percent === 0 && !l.charging)
  const percent = l.kind === "battery" && onFuel ? l.fuel.percent : l.percent
  return { percent, onFuel, text: percent == null ? "–" : `${percent}%` }
}

// The number is calm unless it matters: green while charging, orange when
// low, red when nearly empty.
function levelColor(l) {
  const { percent } = shown(l)
  return l.charging ? GREEN : percent == null ? SECONDARY : percent <= 10 ? RED : percent <= 20 ? ORANGE : PRIMARY
}
// The bars say what they're of: electric in Apple's system green, fuel in
// its system orange. Drawn images can't follow light and dark mode, so it's
// the light mode versions, which read on both.
const BAR_HEX = { battery: "#34C759", fuel: "#FF9500" }
// A winding route, by its iOS 16 name and the older one.
const ROUTE = ["point.topleft.down.to.point.bottomright.curvepath.fill", "point.topleft.down.curvedto.point.bottomright.up.fill", "car.fill"]

function text(stack, value, font, color, scale = 0.6) {
  const t = stack.addText(value)
  t.font = font
  t.textColor = color ?? PRIMARY
  t.lineLimit = 1
  t.minimumScaleFactor = scale
  return t
}

// An SF Symbol, size points tall and as wide as its own shape (a battery is
// much wider than it's tall). Takes a list of names to fall back through,
// for symbols renamed between iOS versions.
function symbol(stack, names, color, size) {
  const s = [names].flat().map((n) => SFSymbol.named(n)).find(Boolean)
  s.applyFont(Font.semiboldSystemFont(size))
  const img = s.image
  const i = stack.addImage(img)
  i.imageSize = new Size(size * img.size.width / img.size.height, size)
  i.tintColor = color
  return i
}

// A battery symbol filled to about the level, by its iOS 17 name and the
// older one.
function batteryIcon(percent) {
  const step = [0, 25, 50, 75, 100].reduce((a, b) => Math.abs(b - percent) < Math.abs(a - percent) ? b : a)
  return [`battery.${step}percent`, `battery.${step}`]
}

// How full, as a rounded bar. Drawn images can't follow light and dark
// mode, so the track is a see-through grey.
// kind is "battery" or "fuel", for the colour.
function bar(stack, l, kind, width, height = 8) {
  const ctx = new DrawContext()
  ctx.size = new Size(width, height)
  ctx.opaque = false
  ctx.respectScreenScale = true
  const pill = (w, color) => {
    const p = new Path()
    p.addRoundedRect(new Rect(0, 0, w, height), height / 2, height / 2)
    ctx.addPath(p)
    ctx.setFillColor(color)
    ctx.fillPath()
  }
  pill(width, new Color("#8E8E93", 0.25))
  if (l.percent > 0) pill(Math.max(height, width * Math.min(l.percent, 100) / 100), new Color(BAR_HEX[kind]))
  const i = stack.addImage(ctx.getImage())
  i.imageSize = new Size(width, height)
}

// The headline: the number in big type, with a symbol when it isn't plain
// battery (the bars say that): fuel, charging or plugged in.
function headline(stack, l, size) {
  const r = stack.addStack()
  r.bottomAlignContent()
  const s = shown(l)
  text(r, s.text, Font.boldRoundedSystemFont(size), levelColor(l), 0.7)
  const icon = s.onFuel ? "fuelpump.fill" : l.charging ? "bolt.fill" : l.plugged ? "powerplug.fill" : null
  if (!icon) return
  r.addSpacer(5)
  const box = r.addStack()
  box.layoutVertically()
  symbol(box, icon, l.charging ? GREEN : SECONDARY, size * 0.42)
  box.addSpacer(size * 0.16)
}

// Under the bar: range, or while charging how long it has to go.
// A plug-in hybrid gives its range on both together, then its electric
// range. long adds "Hybrid mode" when the battery's empty.
function subline(l, long) {
  if (l.charging) return l.left ? `Charging · ${hm(l.left)} left` : "Charging"
  if (l.kind === "battery" && shown(l).onFuel) {
    const range = distance(l.total ?? l.fuel.range)
    return range ? (long ? `Hybrid mode · ${range} range` : `${range} range`) : "Hybrid mode"
  }
  if (l.total != null) return `${distance(l.total)} range${l.range ? `, ${distance(l.range)} EV` : ""}`
  const range = distance(l.range)
  return range ? `${range} range` : l.kind === "fuel" ? "Fuel" : "Battery"
}

// The level as a bar and, for a plug-in hybrid, its fuel as a slimmer one
// underneath, each with its symbol to tell them apart.
function bars(stack, l, width, height = 8) {
  if (l.fuel?.percent == null) return bar(stack, l, l.kind, width, height)
  const s = stack.addStack()
  s.layoutVertically()
  s.spacing = 4
  for (const [icon, level, kind, h] of [[batteryIcon(l.percent ?? 0), l, "battery", height],
                                        ["fuelpump.fill", l.fuel, "fuel", Math.max(4, height - 2)]]) {
    const r = s.addStack()
    r.centerAlignContent()
    const box = r.addStack()
    box.size = new Size(18, 10)
    box.addSpacer()
    symbol(box, icon, SECONDARY, 9)
    box.addSpacer()
    r.addSpacer(4)
    bar(r, level, kind, width - 22, h)
  }
}

// How much was electric: green for that share, orange for the rest, or
// just the track when the car doesn't say.
function splitBar(stack, ev, width, height) {
  const ctx = new DrawContext()
  ctx.size = new Size(width, height)
  ctx.opaque = false
  ctx.respectScreenScale = true
  const pill = (color) => {
    const p = new Path()
    p.addRoundedRect(new Rect(0, 0, width, height), height / 2, height / 2)
    ctx.addPath(p)
    ctx.setFillColor(color)
    ctx.fillPath()
  }
  // DrawContext can't clip, so the pill's drawn in the rest's colour and
  // the electric share laid over it with only its left end rounded.
  if (ev == null) pill(new Color("#8E8E93", 0.25))
  else {
    pill(new Color(BAR_HEX.fuel))
    if (ev > 0) {
      const w = Math.max(height, width * ev)
      const p = new Path()
      p.addRoundedRect(new Rect(0, 0, w, height), height / 2, height / 2)
      if (ev < 1) p.addRect(new Rect(w - height / 2, 0, height / 2, height))
      ctx.addPath(p)
      ctx.setFillColor(new Color(BAR_HEX.battery))
      ctx.fillPath()
    }
  }
  const i = stack.addImage(ctx.getImage())
  i.imageSize = new Size(width, height)
}

// Where it's parked, with a house when that's home.
function placeLine(stack, where, size = 12) {
  const r = stack.addStack()
  r.centerAlignContent()
  symbol(r, where.home ? "house.fill" : "mappin.and.ellipse", SECONDARY, size)
  r.addSpacer(4)
  text(r, where.text, Font.semiboldSystemFont(size), SECONDARY, 0.7)
}

function lockLine(stack, sec, size = 12) {
  if (!sec) return
  const r = stack.addStack()
  r.centerAlignContent()
  const bad = sec.locked === false || sec.open.length
  const color = bad ? ORANGE : SECONDARY
  symbol(r, sec.locked === false ? "lock.open.fill" : "lock.fill", color, size)
  r.addSpacer(4)
  const words = sec.locked === false ? "Unlocked" : sec.locked ? "Locked" : null
  text(r, [words, sec.summary].filter(Boolean).join(" · "), Font.semiboldSystemFont(size), color, 0.7)
}

// The car's name, or the warning in its place, and when it last reported.
function header(stack, d, time, icon = "car.fill") {
  const r = stack.addStack()
  r.centerAlignContent()
  if (d.warning) {
    symbol(r, "exclamationmark.triangle.fill", ORANGE, 11)
    r.addSpacer(4)
    text(r, d.warning, Font.semiboldSystemFont(12), ORANGE, 0.7)
  } else {
    symbol(r, icon, TOYOTA, 12)
    r.addSpacer(5)
    text(r, carName(d.car), Font.semiboldSystemFont(13), TOYOTA, 0.7)
  }
  if (time) {
    r.addSpacer()
    text(r, time, Font.semiboldSystemFont(12), SECONDARY)
  }
}

function addPicture(stack, d, width, height) {
  if (!d.picture) {
    symbol(stack, "car.side.fill", SECONDARY, height * 0.7)
    return
  }
  const i = stack.addImage(d.picture)
  i.imageSize = new Size(width, height)
  i.applyFittingContentMode()
}

function build(d, family, mode) {
  const l = level(d)
  const sec = security(d)
  const time = reported(d)
  const w = new ListWidget()
  w.url = APP_URL
  w.refreshAfterDate = new Date(Date.now() + 20 * 60e3)

  // Lock screen widgets are drawn in one tint, so no colours there.
  const big = shown(l)
  const pct = big.text
  const range = distance(big.onFuel ? l.total ?? l.fuel?.range ?? l.range : l.total ?? l.range)
  if (family === "accessoryInline") {
    const icon = big.onFuel ? "⛽︎" : l.charging ? "⚡︎" : ""
    w.addText([`${icon}${pct}`, range, sec && (sec.locked === false ? "Unlocked" : sec.open.length ? sec.summary : "Locked")]
      .filter(Boolean).join(" · "))
    return w
  }
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true
    const ring = new DrawContext()
    ring.size = new Size(60, 60)
    ring.opaque = false
    ring.respectScreenScale = true
    const arc = (to, alpha) => {
      const p = new Path()
      const steps = Math.max(2, Math.round(to * 60))
      p.move(new Point(30, 5))
      for (let i = 1; i <= steps; i++) {
        const a = -Math.PI / 2 + (i / steps) * to * 2 * Math.PI
        p.addLine(new Point(30 + 25 * Math.cos(a), 30 + 25 * Math.sin(a)))
      }
      ring.addPath(p)
      ring.setStrokeColor(new Color("#FFFFFF", alpha))
      ring.setLineWidth(5)
      ring.strokePath()
    }
    arc(1, 0.3)
    if (big.percent > 0) arc(Math.min(big.percent, 100) / 100, 1)
    const z = w.addStack()
    z.size = new Size(60, 60)
    z.backgroundImage = ring.getImage()
    z.layoutVertically()
    z.addSpacer()
    const top = z.addStack(); top.addSpacer()
    symbol(top, big.onFuel ? "fuelpump.fill" : l.charging ? "bolt.fill" : "car.fill", Color.white(), 10)
    top.addSpacer()
    const mid = z.addStack(); mid.addSpacer()
    text(mid, `${big.percent ?? "–"}`, Font.boldRoundedSystemFont(17), Color.white(), 0.6)
    mid.addSpacer()
    z.addSpacer()
    return w
  }
  if (family === "accessoryRectangular") {
    const top = w.addStack()
    top.centerAlignContent()
    symbol(top, d.warning ? "exclamationmark.triangle.fill" : "car.fill", Color.white(), 12)
    top.addSpacer(4)
    text(top, d.warning ?? carName(d.car), Font.semiboldSystemFont(13), Color.white(), 0.7)
    const mid = w.addStack()
    mid.bottomAlignContent()
    text(mid, pct, Font.boldRoundedSystemFont(20), Color.white())
    mid.addSpacer(6)
    text(mid, l.charging ? (l.left ? `⚡︎ ${hm(l.left)}` : "⚡︎ Charging") : range ?? "", Font.semiboldSystemFont(13), Color.white(), 0.7)
    if (sec) text(w, `${sec.locked === false ? "Unlocked" : "Locked"} · ${sec.summary}`, Font.systemFont(12), Color.white(), 0.7)
    return w
  }

  w.backgroundColor = BG

  if (mode === "trips" && family !== "large") return trips(w, d, family)

  const where = parked(d)
  if (family === "small" || !family) {
    w.setPadding(12, 14, 12, 14)
    const top = w.addStack()
    top.centerAlignContent()
    // At home that's just a house by the lock; anywhere else it's the
    // street on a line of its own, with a smaller car to make room.
    const home = where?.home
    const street = where && !home
    addPicture(top, d, WIDGET.small - (home ? 74 : 50), street ? 40 : 52)
    top.addSpacer()
    if (home) {
      symbol(top, "house.fill", AMBER, 14)
      top.addSpacer(6)
    }
    if (d.warning) symbol(top, "exclamationmark.triangle.fill", ORANGE, 14)
    else if (sec) symbol(top, sec.locked === false ? "lock.open.fill" : "lock.fill",
                         sec.locked === false || sec.open.length ? ORANGE : BLUE, 14)
    w.addSpacer()
    headline(w, l, l.fuel ? 28 : 30)
    w.addSpacer(4)
    bars(w, l, WIDGET.small - 28, 6)
    w.addSpacer(5)
    text(w, subline(l), Font.semiboldSystemFont(12), l.charging ? GREEN : SECONDARY, 0.7)
    if (street) {
      w.addSpacer(2)
      placeLine(w, where)
    }
    return w
  }

  if (family === "large") {
    // Large: the car big across the top, the level under it, then tiles.
    // Everything but the picture has a set height, and the picture takes
    // what's left, so nothing's left over as gaps.
    const inner = WIDGET.width - 32
    const pictureHeight = Math.max(60, WIDGET.large - (l.fuel ? 251 : 239))
    w.setPadding(14, 16, 16, 16)
    // The mileage has no tile any more, so it's up by the time.
    const odo = distance(toUnits(d.telemetry?.odometer))
    header(w, d, [odo, time].filter(Boolean).join(" · "))
    w.addSpacer(4)
    const pic = w.addStack()
    pic.addSpacer()
    // Narrower than the widget by the spacers' own minimum widths: any
    // wider and the whole widget's pushed off centre to fit it.
    addPicture(pic, d, inner - 16, pictureHeight)
    pic.addSpacer()
    w.addSpacer(6)
    const row = w.addStack()
    row.bottomAlignContent()
    headline(row, l, 38)
    row.addSpacer()
    text(row, subline(l), Font.semiboldSystemFont(13), l.charging ? GREEN : SECONDARY, 0.7)
    w.addSpacer(6)
    bars(w, l, inner, 10)
    w.addSpacer(14)
    const drive = driving(d)
    const locks = sec ? [sec.locked === false ? "Unlocked" : sec.locked ? "Locked" : null, sec.summary].filter(Boolean).join(" · ") : "–"
    const last = drive?.last && [tripDistance(drive.last.distance), electricShare(drive.last.ev, true)].filter(Boolean).join(" · ")
    const month = drive && [distance(drive.month?.distance ?? 0), electricShare(drive.month?.ev, true)].filter(Boolean).join(" · ")
    const tiles = [
      ["Parked", where?.short ?? "–", false],
      ["Locks", locks, sec?.locked === false || sec?.open.length > 0],
      ["Last drive", last || "–", false],
      [drive?.monthName ?? "This month", month || "–", false],
    ]
    for (let i = 0; i < tiles.length; i += 2) {
      if (i) w.addSpacer(8)
      const r = w.addStack()
      tiles.slice(i, i + 2).forEach(([label, value, bad], j) => {
        if (j) r.addSpacer(8)
        tile(r, label, value, bad, (inner - 8) / 2)
      })
    }
    w.addSpacer()
    return w
  }

  // Medium: the car on the left, the level on the right, and its locks and
  // mileage along the bottom.
  w.setPadding(14, 16, 14, 16)
  header(w, d, time)
  w.addSpacer()
  const row = w.addStack()
  row.centerAlignContent()
  addPicture(row, d, 132, 70)
  row.addSpacer()
  const right = row.addStack()
  right.layoutVertically()
  headline(right, l, 34)
  right.addSpacer(6)
  bars(right, l, 150)
  right.addSpacer(6)
  text(right, subline(l, true), Font.semiboldSystemFont(12), l.charging ? GREEN : SECONDARY, 0.7)
  w.addSpacer()
  const foot = w.addStack()
  foot.centerAlignContent()
  lockLine(foot, sec)
  foot.addSpacer()
  // Where it's parked, or the mileage when Toyota hasn't said.
  const odo = distance(toUnits(d.telemetry?.odometer))
  if (where) placeLine(foot, where)
  else if (odo) text(foot, odo, Font.semiboldSystemFont(12), SECONDARY)
  return w
}

// The driving widget: the month's distance, with how much of it was
// electric as a bar, and the last drive.
function trips(w, d, family) {
  const drive = driving(d)
  const m = drive?.month, last = drive?.last
  const monthName = drive?.monthName ?? new Date().toLocaleString("en-GB", { month: "long" })
  const monthLine = m ? [electricShare(m.ev), m.economy].filter(Boolean).join(" · ") : "No drives yet"
  const lastLine = last && [tripDistance(last.distance), `${last.minutes} min`, electricShare(last.ev, true)]
    .filter(Boolean).join(" · ")
  const small = Font.semiboldSystemFont(12)

  if (family === "medium") {
    w.setPadding(14, 16, 14, 16)
    const where = parked(d)
    header(w, d, where && (where.since ? `${where.short} since ${when(where.since)}` : where.short), ROUTE)
    w.addSpacer()
    const row = w.addStack()
    const width = (WIDGET.width - 32 - 16) / 2
    const column = () => {
      const c = row.addStack()
      c.layoutVertically()
      c.size = new Size(width, 0)
      return c
    }
    const a = column()
    text(a, last ? `Last drive · ${when(last.ended)}` : "Last drive", small, SECONDARY)
    text(a, tripDistance(last?.distance) ?? "–", Font.boldRoundedSystemFont(26))
    if (last) {
      text(a, [`${last.minutes} min`, electricShare(last.ev)].filter(Boolean).join(" · "), small, SECONDARY, 0.7)
      if (last.score != null) text(a, `Score ${last.score}`, small, SECONDARY)
    } else text(a, "None in 30 days", small, SECONDARY)
    row.addSpacer(16)
    const b = column()
    text(b, monthName, small, SECONDARY)
    text(b, distance(m?.distance ?? 0), Font.boldRoundedSystemFont(26))
    b.addSpacer(4)
    splitBar(b, m?.ev, width, 6)
    b.addSpacer(5)
    text(b, monthLine, small, SECONDARY, 0.7)
    w.addSpacer()
    return w
  }

  w.setPadding(12, 14, 12, 14)
  const top = w.addStack()
  top.centerAlignContent()
  symbol(top, ROUTE, TOYOTA, 12)
  top.addSpacer(5)
  text(top, monthName, Font.semiboldSystemFont(13), TOYOTA, 0.7)
  w.addSpacer()
  text(w, distance(m?.distance ?? 0), Font.boldRoundedSystemFont(28), PRIMARY, 0.7)
  w.addSpacer(4)
  splitBar(w, m?.ev, WIDGET.small - 28, 6)
  w.addSpacer(5)
  text(w, monthLine, small, SECONDARY, 0.7)
  if (last) {
    w.addSpacer(8)
    text(w, "Last drive", small, PRIMARY)
    text(w, lastLine, small, SECONDARY, 0.7)
  }
  return w
}

// A labelled value on a soft rounded panel, orange when it needs a look.
function tile(stack, label, value, bad, width) {
  const t = stack.addStack()
  t.layoutVertically()
  t.size = new Size(width, 56)
  t.backgroundColor = new Color("#8E8E93", 0.12)
  t.cornerRadius = 14
  t.setPadding(9, 12, 9, 12)
  text(t, label, Font.semiboldSystemFont(11), SECONDARY)
  t.addSpacer()
  const r = t.addStack()
  text(r, value, Font.semiboldRoundedSystemFont(18), bad ? ORANGE : PRIMARY, 0.6)
  r.addSpacer()
}

function failed(message) {
  const w = new ListWidget()
  w.backgroundColor = BG
  const t = w.addText(`Toyota: ${message}`)
  t.font = Font.systemFont(11)
  t.textColor = SECONDARY
  w.refreshAfterDate = new Date(Date.now() + 30 * 60e3)
  return w
}

let family = config.widgetFamily ?? args.queryParameters.size
let mode = (args.widgetParameter ?? args.queryParameters.mode ?? "").trim().toLowerCase()
let data, widget
try {
  data = await loadOrCached()
} catch (e) {
  widget = failed(e.message)
}

// Run in the app: pick which widget to look at, or save where the car's
// parked as home.
let show = true
if (data && !config.runsInWidget && !family) {
  const a = new Alert()
  a.title = "Toyota"
  const actions = []
  const add = (title, run, destructive) => {
    destructive ? a.addDestructiveAction(title) : a.addAction(title)
    actions.push(run)
  }
  for (const [title, f, m] of [["Small", "small", ""], ["Medium", "medium", ""], ["Large", "large", ""],
                               ["Small · driving", "small", "trips"], ["Medium · driving", "medium", "trips"]]) {
    add(title, () => { family = f; mode = m })
  }
  if (data.place) {
    add("Set home to where it's parked", () => {
      save(HOME_KEY, { lat: data.place.lat, lon: data.place.lon })
      family = "medium"
    })
  }
  if (Keychain.contains(HOME_KEY)) add("Forget home", () => { Keychain.remove(HOME_KEY); family = "medium" }, true)
  a.addCancelAction("Cancel")
  const i = await a.presentSheet()
  if (i === -1) show = false
  else actions[i]()
}

family ??= "medium"
widget ??= build(data, family, mode)
if (config.runsInWidget) Script.setWidget(widget)
else if (show) {
  await (family === "small" ? widget.presentSmall() : family === "large" ? widget.presentLarge() : widget.presentMedium())
}
Script.complete()
