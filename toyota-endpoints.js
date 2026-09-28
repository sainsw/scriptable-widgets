// Toyota Endpoints: a Scriptable script (not a widget) that calls every
// read-only endpoint of the MyToyota app's backend that pytoyoda knows about
// (https://github.com/pytoyoda/pytoyoda/blob/main/pytoyoda/const.py) and shows
// what each sends back, raw: for seeing what the Toyota widget has to work
// with. It leaves out the ones that do something (remote commands, climate
// control, asking the car to report in), so running it doesn't wake the car.
//
// It shares the Toyota widget's login and session from the Keychain, so if
// that's set up there's nothing to type in. The bodies are shown in Quick
// Look, copied to the clipboard, and saved as toyota-endpoints.json in
// Scriptable's documents.

const VIN = "" // which car, if the account has more than one; blank for the first
const TRIP_DAYS = 7 // how far back to ask for trips
const LOGIN_KEY = "toyota_widget_login"
const TOKEN_KEY = "toyota_widget_tokens"

// The MyToyota app's own client details, as pytoyoda uses them. The same as
// toyota.js; the login below is copied from there too.
const AUTH = "https://b2c-login.toyota-europe.com"
const REALM = `${AUTH}/json/realms/root/realms/tme`
const OAUTH = `${AUTH}/oauth2/realms/root/realms/tme`
const REDIRECT = "com.toyota.oneapp:/oauth2Callback"
const BASIC = "basic b25lYXBwOm9uZWFwcA=="
const API = "https://ctpa-oneapi.tceu-ctp-prd.toyotaconnectedeurope.io"
const API_KEY = "tTZipv6liF74PwMfk9Ed68AQ0bISswwf3iHQdqcF"
const APP_VERSION = "2.14.0"

// ---------------------------------------------------------------------------
// Logging in

const saved = (key) => Keychain.contains(key) ? JSON.parse(Keychain.get(key)) : null
const save = (key, value) => Keychain.set(key, JSON.stringify(value))

async function login() {
  const kept = saved(LOGIN_KEY)
  if (kept) return kept
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
        throw new Error("Toyota doesn't know that email")
      }
    }
    const req = new Request(`${REALM}/authenticate?authIndexType=service&authIndexValue=oneapp`)
    req.method = "POST"
    req.headers = { "Content-Type": "application/json" }
    req.body = JSON.stringify(data)
    data = await req.loadJSON()
    if (req.response.statusCode === 401) {
      Keychain.remove(LOGIN_KEY)
      throw new Error("Wrong MyToyota email or password")
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
// The endpoints

// Whatever comes back, whatever the status: the body as JSON when it is,
// and as text when it isn't.
async function call(path, vin, retried) {
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
  let raw, error
  try { raw = await req.loadString() } catch (e) { error = e.message }
  const status = req.response?.statusCode ?? null
  if (status === 401 && !retried) return call(path, vin, true)
  let body = raw ?? null
  try { body = JSON.parse(raw) } catch {}
  return { path, status, ...(error ? { error } : {}), body }
}

const day = (d) => d.toISOString().slice(0, 10)

async function run() {
  const cars = await call("/v2/vehicle/guid")
  const car = cars.body?.payload?.find((v) => !VIN || v.vin === VIN)
  if (!car) return [cars]
  const vin = car.vin
  const to = new Date()
  const from = new Date(to - TRIP_DAYS * 86400e3)
  const paths = [
    "/v1/vehicle-association/vehicle",
    "/v3/telemetry",
    "/v1/vehicle/status",
    "/v1/vehicle/electric/status",
    "/v1/location",
    "/v1/vehiclehealth/status",
    "/v2/notification/history",
    `/v1/trips?from=${day(from)}&to=${day(to)}&route=false&summary=true&limit=5&offset=0`,
    "/v1/servicehistory/vehicle/summary",
    "/v1/vehicle/climate-settings",
    "/v1/vehicle/climate-status",
  ]
  return [cars, ...(await Promise.all(paths.map((p) => call(p, vin).catch((e) => ({ path: p, error: e.message })))))]
}

let results
try {
  results = await run()
} catch (e) {
  results = [{ error: e.message }]
}
const out = JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2)
const fm = FileManager.local()
fm.writeString(fm.joinPath(fm.documentsDirectory(), "toyota-endpoints.json"), out)
Pasteboard.copyString(out)
if (!config.runsInWidget) await QuickLook.present(out, true)
Script.complete()
