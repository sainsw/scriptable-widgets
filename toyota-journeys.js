// Toyota Journeys: a Scriptable widget (https://scriptable.app) charting
// your recent drives from the MyToyota app, a bar per journey, oldest on
// the left. A bar is as tall as the drive was long, green for the miles
// driven on electric and amber for the miles on petrol, so a plug-in
// hybrid's short drives are all green and a long one goes amber once the
// battery's run out.
//
// Toyota says how far of a drive was electric but not how much electricity
// it used, so the only consumption there is to give is petrol's: under the
// chart is the mpg over all the miles, electric ones included, as the car's
// own dashboard gives it.
//
// It shares the Toyota widget's login and session from the Keychain, so if
// that's set up there's nothing to type in; otherwise run it once in
// Scriptable and log in. The login is copied from toyota.js.

const UNITS = "mi" // "mi" or "km"
const VIN = "" // which car, if the account has more than one; blank for the first
const DAYS = 30 // how far back to look for journeys
const LOGIN_KEY = "toyota_widget_login"
const TOKEN_KEY = "toyota_widget_tokens"

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

async function tokens(grant) {
  const req = new Request(`${OAUTH}/access_token`)
  req.method = "POST"
  req.headers = { Authorization: BASIC, "Content-Type": "application/x-www-form-urlencoded" }
  req.body = Object.entries({ client_id: "oneapp", redirect_uri: REDIRECT, code_verifier: "plain", ...grant })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
  const res = await req.loadJSON()
  if (req.response.statusCode !== 200 || !res.access_token) throw new Error(`Toyota tokens returned ${req.response.statusCode}`)
  const claims = JSON.parse(Data.fromBase64String(base64(res.id_token.split(".")[1])).toRawString())
  const t = { access: res.access_token, refresh: res.refresh_token, uuid: claims.uuid,
              expires: Date.now() + (res.expires_in - 60) * 1000 }
  save(TOKEN_KEY, t)
  return t
}

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
// The HMAC-SHA256 the app sends of the account ID, as in toyota.js.

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
// The journeys

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
  if (status === 401 && !retried) return api(path, vin, true)
  if (status !== 200) throw new Error(`Toyota ${path} returned ${status ?? "nothing"}`)
  return res?.payload
}

// Bars per widget size; the large one's is as many as are asked for.
const SLOTS = { small: 8, medium: 16, large: 24 }

// A journey as it's drawn: lengths in metres, fuel in millilitres.
const journey = (t) => ({
  start: t.summary.startTs,
  end: t.summary.endTs,
  metres: t.summary.length ?? 0,
  ml: t.summary.fuelConsumption ?? 0,
  ev: t.hdc?.evDistance ?? null,
})

// The latest journeys, newest first, kept on the phone: if Toyota can't be
// reached, the last ones are shown, marked as such. The car's VIN is kept
// with them, so it's only looked up the once.
async function load() {
  const fm = FileManager.local()
  const dir = fm.joinPath(fm.documentsDirectory(), Script.name())
  if (!fm.fileExists(dir)) fm.createDirectory(dir)
  const cache = fm.joinPath(dir, "journeys.json")
  const kept = fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : null
  try {
    let vin = kept?.vin && (!VIN || kept.vin === VIN) ? kept.vin : null
    if (!vin) {
      const cars = await api("/v2/vehicle/guid")
      vin = cars?.find((v) => !VIN || v.vin === VIN)?.vin
      if (!vin) throw new Error(VIN ? `No car with VIN ${VIN}` : "No cars on this MyToyota account")
    }
    const now = new Date()
    const from = new Date(now - DAYS * 86400e3)
    const res = await api(`/v1/trips?from=${ymd(from)}&to=${ymd(now)}&route=false&summary=true` +
      `&limit=${SLOTS.large}&offset=0`, vin)
    const d = { vin, fetchedAt: Date.now(), trips: (res?.trips ?? []).map(journey) }
    fm.writeString(cache, JSON.stringify(d))
    return d
  } catch (e) {
    if (!kept) throw e
    return { ...kept, warning: e instanceof NeedsLogin ? "Log in to Toyota again" : "Can't reach Toyota" }
  }
}

const ymd = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`

// ---------------------------------------------------------------------------
// What to show

// The share driven on electric, when the car says.
const share = (j) => j.ev == null || !j.metres ? null : Math.min(1, j.ev / j.metres)

// Metres in whichever units.
const toUnits = (m) => UNITS === "mi" ? m / 1609.344 : m / 1000

// The chart's top: the longest journey rounded up to 1, 2 or 5 of
// something, so the line along the top is a round distance.
function scale(js) {
  const longest = Math.max(1, ...js.map((j) => toUnits(j.metres)))
  const step = 10 ** Math.floor(Math.log10(longest))
  return [1, 2, 5, 10].map((n) => n * step).find((n) => n >= longest)
}

// mpg in miles, litres per 100 km in kilometres. Mostly on electric, the
// mpg runs into the thousands, so from 500 it's just endless.
function economy(m, ml) {
  if (!m) return null
  if (UNITS !== "mi") return `${(ml / 1000 / (m / 100e3)).toFixed(1)} L/100km`
  const mpg = ml ? (m / 1609.344) / (ml / 4546.09) : Infinity
  return mpg >= 500 ? "∞ mpg" : `${Math.round(mpg)} mpg`
}

const electricShare = (ev) => ev == null ? null
  : ev >= 0.995 ? "all EV" : ev < 0.005 ? "no EV" : `${Math.round(ev * 100)}% EV`

// The journeys on the chart all together: how much was electric, and the
// mpg over the lot.
function totals(js) {
  const ml = js.reduce((s, j) => s + j.ml, 0)
  const metres = js.reduce((s, j) => s + j.metres, 0)
  const known = js.filter((j) => j.ev != null)
  const knownMetres = known.reduce((s, j) => s + j.metres, 0)
  const ev = knownMetres ? Math.min(1, known.reduce((s, j) => s + j.ev, 0) / knownMetres) : null
  return [electricShare(ev), economy(metres, ml)].filter(Boolean).join(" · ")
}

// A time as just the time today, or with the day before that.
function when(time) {
  const t = new Date(time)
  return t.toDateString() === new Date().toDateString()
    ? t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })
}

// A day under the chart: the weekday this past week, the date before that.
function dayLabel(time) {
  const t = new Date(time)
  return Date.now() - t < 6 * 86400e3
    ? t.toLocaleDateString("en-GB", { weekday: "short" })
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// ---------------------------------------------------------------------------
// Drawing

// Widget sizes in points, as in toyota.js: the small's side, the medium's
// and large's width, and the large's height.
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
const ORANGE = dyn("#C93400", "#FF9F0A")
const TOYOTA = dyn("#EB0A1E", "#FF3B45")
// Electric in Apple's system green, petrol in its system orange, as the
// Toyota widget's bars. Drawn images can't follow light and dark mode, so
// it's the light mode versions, which read on both, and a grey for the
// lines and labels that does too.
const BAR_HEX = { ev: "#34C759", fuel: "#FF9500", none: "#8E8E93" }
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

function symbol(stack, names, color, size) {
  const s = [names].flat().map((n) => SFSymbol.named(n)).find(Boolean)
  s.applyFont(Font.semiboldSystemFont(size))
  const img = s.image
  const i = stack.addImage(img)
  i.imageSize = new Size(size * img.size.width / img.size.height, size)
  i.tintColor = color
  return i
}

// The chart: a bar per journey, oldest first, in slots bars' worth of room
// so they're the same width however many there are, kept to the right so
// the latest is always at the end. The top line is top miles (or km), and
// days can go underneath, under each day's first journey.
//
// Heights are on a log scale, log(1 + distance), so a mile's drive still
// shows next to a long one, and none is still nothing. A faint line marks
// each power of ten below the top: 1, 10, 100.
function chart(stack, js, slots, top, width, height, days) {
  const ctx = new DrawContext()
  ctx.size = new Size(width, height)
  ctx.opaque = false
  ctx.respectScreenScale = true
  const grey = (alpha) => new Color(BAR_HEX.none, alpha)
  const labels = days ? 14 : 0
  const pad = 13
  const base = height - labels
  const tall = base - pad
  const gap = slots > 16 ? 3 : 4
  const bw = (width - gap * (slots - 1)) / slots
  const r = Math.min(3, bw / 2)

  const line = (y, alpha) => {
    const p = new Path()
    p.addRect(new Rect(0, y, width, 0.5))
    ctx.addPath(p)
    ctx.setFillColor(grey(alpha))
    ctx.fillPath()
  }
  line(pad, 0.25)
  const y = (d) => base - tall * Math.min(1, Math.log1p(d) / Math.log1p(top))
  for (let d = 1; d < top; d *= 10) line(y(d), 0.15)
  line(base - 0.5, 0.35)
  ctx.setFont(Font.semiboldSystemFont(9))
  ctx.setTextColor(grey(1))
  ctx.setTextAlignedRight()
  ctx.drawTextInRect(`${top} ${UNITS}`, new Rect(0, 0, width, 11))
  ctx.setTextAlignedLeft()

  const rounded = (x, y, h, color, square) => {
    const p = new Path()
    const rr = Math.min(r, h / 2)
    p.addRoundedRect(new Rect(x, y, bw, h), rr, rr)
    // Squares off the top, where the green meets the amber.
    if (square) p.addRect(new Rect(x, y, bw, Math.min(rr, h)))
    ctx.addPath(p)
    ctx.setFillColor(color)
    ctx.fillPath()
  }
  const offset = slots - js.length
  let lastDay = null, lastLabel = -Infinity
  js.forEach((j, i) => {
    const x = (offset + i) * (bw + gap)
    const h = Math.max(2 * r, base - y(toUnits(j.metres)))
    const ev = share(j)
    // DrawContext can't clip, so the bar's drawn in amber and the electric
    // miles laid over it from the bottom.
    rounded(x, base - h, h, ev == null ? grey(0.5) : new Color(BAR_HEX.fuel))
    if (ev > 0) {
      const g = ev >= 0.995 ? h : h * ev
      rounded(x, base - g, g, new Color(BAR_HEX.ev), ev < 0.995)
    }
    const day = new Date(j.start).toDateString()
    if (days && day !== lastDay) {
      lastDay = day
      if (x - lastLabel >= 30) {
        ctx.drawText(dayLabel(j.start), new Point(x, base + 2))
        lastLabel = x
      }
    }
  })
  // Drawn for the widget's size from the table, but left to shrink to fit
  // rather than set to it: widgets aren't always that size (Scriptable's
  // preview is narrower), and a set size wider than the widget pushes
  // everything off centre.
  const i = stack.addImage(ctx.getImage())
  i.applyFittingContentMode()
}

// The title, or the warning in its place, and when the last journey ended.
function header(stack, d, time) {
  const r = stack.addStack()
  r.centerAlignContent()
  if (d.warning) {
    symbol(r, "exclamationmark.triangle.fill", ORANGE, 11)
    r.addSpacer(4)
    text(r, d.warning, Font.semiboldSystemFont(12), ORANGE, 0.7)
  } else {
    symbol(r, ROUTE, TOYOTA, 12)
    r.addSpacer(5)
    text(r, "Journeys", Font.semiboldSystemFont(13), TOYOTA, 0.7)
  }
  if (time) {
    r.addSpacer()
    text(r, when(time), Font.semiboldSystemFont(12), SECONDARY)
  }
}

// Which colour's which.
function legend(stack) {
  const r = stack.addStack()
  r.centerAlignContent()
  for (const [i, [label, hex]] of [["Electric", BAR_HEX.ev], ["Petrol", BAR_HEX.fuel]].entries()) {
    if (i) r.addSpacer(8)
    text(r, "●", Font.systemFont(9), new Color(hex))
    r.addSpacer(3)
    text(r, label, Font.semiboldSystemFont(12), SECONDARY)
  }
}

function build(d, family) {
  const w = new ListWidget()
  w.url = APP_URL
  w.refreshAfterDate = new Date(Date.now() + 20 * 60e3)
  const slots = SLOTS[family] ?? SLOTS.medium
  const js = d.trips.slice(0, slots).reverse()
  const summary = totals(js)

  // Lock screen widgets are drawn in one tint, so the colours would be
  // lost: just the totals.
  if (family?.startsWith("accessory")) {
    w.addText(js.length ? summary : "No journeys")
    return w
  }

  w.backgroundColor = BG
  const small = family === "small"
  const [pt, ps] = small ? [12, 14] : [14, 16]
  w.setPadding(pt, ps, pt, ps)
  header(w, d, js.at(-1)?.end)
  w.addSpacer(6)
  if (!js.length) {
    w.addSpacer()
    text(w, `No journeys in the last ${DAYS} days`, Font.semiboldSystemFont(12), SECONDARY, 0.7)
    w.addSpacer()
    return w
  }
  // The chart takes whatever the title and the line under it leave.
  const width = (small ? WIDGET.small : WIDGET.width) - 2 * ps
  const tall = (family === "large" ? WIDGET.large : WIDGET.small) - 2 * pt - 16 - 6 - 6 - 15 - 4
  chart(w, js, slots, scale(js), width, tall, !small)
  w.addSpacer()
  const foot = w.addStack()
  foot.centerAlignContent()
  if (!small) {
    legend(foot)
    foot.addSpacer()
  }
  text(foot, summary, Font.semiboldSystemFont(12), small ? SECONDARY : PRIMARY, 0.7)
  return w
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
let data, widget
try {
  data = await load()
} catch (e) {
  widget = failed(e.message)
}

// Run in the app: pick which size to look at.
let show = true
if (!config.runsInWidget && !family) {
  const a = new Alert()
  a.title = "Toyota Journeys"
  const sizes = ["small", "medium", "large"]
  for (const s of sizes) a.addAction(s[0].toUpperCase() + s.slice(1))
  a.addCancelAction("Cancel")
  const i = await a.presentSheet()
  if (i === -1) show = false
  else family = sizes[i]
}

family ??= "medium"
widget ??= build(data, family)
if (config.runsInWidget) Script.setWidget(widget)
else if (show) {
  await (family === "small" ? widget.presentSmall() : family === "large" ? widget.presentLarge() : widget.presentMedium())
}
Script.complete()
