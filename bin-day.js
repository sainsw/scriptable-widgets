// Bin day: a Scriptable widget (https://scriptable.app) showing Manchester
// City Council's next bin collection and which bins go out for it, each
// drawn as the council's own wheelie bin icon in the bin's colour.
//
// It asks Manchester's bin checker (the one behind
// manchester.gov.uk/bincollections) directly, so it needs no token. Setup:
//   1. Find your UPRN, the council's number for your address: search your
//      postcode at https://www.findmyaddress.co.uk.
//   2. Run the script once in Scriptable and paste the UPRN when asked. It's
//      kept in the iOS Keychain, so your address never goes in this file.
//   3. Add a Scriptable widget, long-press it → Edit Widget → pick this script.

const KEY = "bin_day_uprn"
const PORTAL = "https://manchester.form.uk.empro.verintcloudservices.com"
const COUNCIL_URL = "https://www.manchester.gov.uk/bincollections"
// Bins should be out by 7am on collection day.
const OUT_BY = 7

// The four bins, in the order they're drawn, keyed by the bin checker's
// field for them, with a word for what goes in each. The black bin is the
// one the council calls grey; brown is glass, cans and plastic bottles, and
// green is garden and food waste.
const BINS = [
  { key: "ahtm_dates_black_bin", name: "Black", what: "Rubbish", body: "#58585D" },
  { key: "ahtm_dates_blue_pulpable_bin", name: "Blue", what: "Paper", body: "#1A7FF5" },
  { key: "ahtm_dates_brown_commingled_bin", name: "Brown", what: "Glass", body: "#A8723F" },
  { key: "ahtm_dates_green_organic_bin", name: "Green", what: "Garden", body: "#32B955" },
]

async function uprn() {
  if (Keychain.contains(KEY)) return Keychain.get(KEY)
  if (config.runsInWidget) throw new Error("Run the script in Scriptable once to add your address")
  const a = new Alert()
  a.title = "Your UPRN"
  a.message = "Manchester's number for your address. Search your postcode at findmyaddress.co.uk to find it."
  a.addTextField("e.g. 77127089")
  a.addAction("Save")
  a.addAction("Find mine")
  a.addCancelAction("Cancel")
  const choice = await a.present()
  if (choice === 1) Safari.open("https://www.findmyaddress.co.uk/search")
  if (choice !== 0) throw new Error("No UPRN")
  const v = a.textFieldValue(0).replace(/\D/g, "")
  if (!v) throw new Error("No UPRN")
  Keychain.set(KEY, v)
  return v
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const dayOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d) }
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

// The bin checker wants a session token first, which it hands out in the
// Authorization header of an anonymous citizen request. Returns each bin's
// collection dates as yyyy-mm-dd.
async function fetchBins(id) {
  const auth = new Request(`${PORTAL}/api/citizen?archived=Y&preview=false&locale=en`)
  await auth.load()
  const headers = auth.response.headers ?? {}
  const token = headers[Object.keys(headers).find((k) => k.toLowerCase() === "authorization")]
  if (!token) throw new Error("Manchester's bin checker didn't answer")

  const today = new Date()
  const req = new Request(`${PORTAL}/api/custom?action=bin_checker-get_bin_col_info&actionedby=_KDF_custom&loadform=true&access=citizen&locale=en`)
  req.method = "POST"
  req.headers = {
    Authorization: token,
    Referer: "https://manchester.portal.uk.empro.verintcloudservices.com/",
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  req.body = JSON.stringify({
    name: "sr_bin_coll_day_checker",
    data: { uprn: id, nextCollectionFromDate: iso(addDays(today, -1)), nextCollectionToDate: iso(addDays(today, 70)) },
    email: "", caseid: "", xref: "", xref1: "", xref2: "",
  })
  const res = await req.loadJSON()
  if (req.response.statusCode !== 200 || !res?.data) throw new Error(`Bin checker returned ${req.response.statusCode}`)

  // Dates come as "02/10/2026 00:00:00" separated by semicolons.
  const dates = {}
  for (const b of BINS) {
    dates[b.name] = (res.data[b.key] ?? "").split(";")
      .map((s) => s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/))
      .filter(Boolean)
      .map(([, d, m, y]) => `${y}-${m}-${d}`)
  }
  if (!Object.values(dates).some((d) => d.length)) throw new Error("No collections found for that UPRN")
  return dates
}

// Collection dates hardly ever change, so they're kept on the phone and
// fetched again every few hours. If the council can't be reached, the kept
// ones are used; they're only flagged once they're over a week old.
async function loadOrCached() {
  const fm = FileManager.local()
  const cache = fm.joinPath(fm.documentsDirectory(), `${Script.name()}.json`)
  const kept = fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : null
  if (kept && Date.now() - kept.fetchedAt < 6 * 3600e3 && config.runsInWidget) return kept
  try {
    const d = { dates: await fetchBins(await uprn()), fetchedAt: Date.now() }
    fm.writeString(cache, JSON.stringify(d))
    return d
  } catch (e) {
    if (!kept) throw e
    return { ...kept, stale: Date.now() - kept.fetchedAt > 7 * 86400e3 }
  }
}

// Collections from today on, soonest first, each with its bins in BINS order.
function collections(dates) {
  const today = iso(new Date())
  const byDay = {}
  for (const b of BINS) {
    for (const d of dates[b.name] ?? []) if (d >= today) (byDay[d] ??= []).push(b)
  }
  return Object.keys(byDay).sort().map((d) => ({ date: dayOf(d), bins: byDay[d] }))
}

// How to say when a collection is: the headline, the line under it, and
// what to do about it now.
function when(c) {
  const now = new Date()
  const days = Math.round((c.date - dayOf(iso(now))) / 86400e3)
  const weekday = c.date.toLocaleDateString("en-GB", { weekday: "long" })
  const date = c.date.toLocaleDateString("en-GB", { day: "numeric", month: "long" })
  const short = c.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
  if (days === 0) {
    return now.getHours() < OUT_BY
      ? { days, hero: "Today", sub: `${weekday} ${date}`, short: "Today", act: `Out by ${OUT_BY}am`, icon: "sunrise.fill", tone: "urgent" }
      : { days, hero: "Today", sub: `${weekday} ${date}`, short: "Today", act: "Bring them in", icon: "arrow.uturn.backward", tone: "done" }
  }
  if (days === 1) {
    return { days, hero: "Tomorrow", sub: `${weekday} ${date}`, short: "Tmrw", act: "Put out tonight", icon: "moon.stars.fill", tone: "soon" }
  }
  if (days < 7) {
    return { days, hero: weekday, sub: date, short: short.split(" ")[0], act: `In ${days} days`, icon: "calendar", tone: "later" }
  }
  return { days, hero: c.date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), sub: weekday,
           short, act: `In ${days} days`, icon: "calendar", tone: "later" }
}

const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark))
const BG = dyn("#FFFFFF", "#1C1C1E")
const PRIMARY = dyn("#000000", "#FFFFFF")
const SECONDARY = dyn("#8A8A8E", "#98989F")
const ACCENT = dyn("#248A3D", "#30D158")
const WARN = dyn("#FF9500", "#FF9F0A")
// The "what to do" pill, by how soon the collection is.
const TONES = {
  urgent: { fg: dyn("#C93400", "#FF9F0A"), bg: new Color("#FF9F0A", 0.18) },
  soon: { fg: dyn("#4B3FC7", "#A5A0FF"), bg: new Color("#5E5CE6", 0.18) },
  done: { fg: dyn("#248A3D", "#30D158"), bg: new Color("#30D158", 0.16) },
  later: { fg: SECONDARY, bg: new Color("#8E8E93", 0.14) },
}

// The wheelie bin from Manchester City Council's own icon font (mcc-icons,
// U+E004, the icon on its Bins pages), as an SVG-style path in font units:
// 480 wide, 694 tall, y downwards. The first shape is the bin's outline; the
// rest are the lines drawn inside it.
const BIN_GLYPH = "M469 511Q465 502 459 498Q452 494 445 494Q445 494 445 494Q444 493 444 493Q443 493 443 493Q443 493 442 493Q442 493 442 493Q441 493 440 493L438 493Q438 493 438 493Q437 493 436 493Q436 493 436 493Q435 493 435 493L434 493L446 155Q447 155 448 155Q449 154 450 153Q463 141 460 127Q456 113 448 105Q448 104 447 104Q446 103 446 103Q443 101 419 88Q395 74 367 58Q338 41 313 27Q289 13 286 11Q269 3 256 2Q242 0 226 5Q224 5 222 6Q220 7 218 8Q217 8 216 9Q215 9 213 10Q212 10 207 11Q202 11 198 11Q188 11 177 12Q165 12 154 16Q152 17 139 24Q126 31 108 41L105 32Q105 32 103 29Q100 25 91 28Q83 31 60 45Q37 59 37 59Q37 59 36 60Q35 61 36 66Q37 70 37 75Q37 80 37 82Q32 85 29 87Q25 89 22 90Q21 91 12 100Q2 109 0 123Q0 123 0 124Q0 125 0 126L0 129Q0 131 1 133Q2 135 3 138Q4 141 7 152Q9 162 12 174Q14 184 20 190Q26 195 31 199Q32 199 34 201Q35 202 35 202Q40 222 45 260Q51 299 57 345Q62 391 67 439Q72 487 77 524Q84 589 86 601Q87 612 92 614Q110 625 126 635Q142 645 157 655Q170 663 182 671Q194 679 207 687Q213 690 220 692Q226 693 232 693Q245 693 254 690Q263 686 264 686Q267 684 313 661Q358 638 389 621Q391 624 394 626Q397 627 400 628Q402 628 404 629Q405 629 407 629Q407 629 408 630Q408 630 408 630Q410 630 412 630Q414 630 416 630Q416 630 416 630Q416 630 416 630Q417 630 419 630Q420 630 421 630Q421 630 421 630Q421 630 421 630Q421 630 421 630Q421 630 421 630Q430 631 440 626Q449 620 458 608Q472 587 476 559Q479 530 469 511ZM358 233L293 263L293 280L358 250L358 233ZM226 298Q245 298 260 294Q275 289 282 285L283 268Q282 268 249 281Q215 293 172 269Q129 245 99 226Q69 207 60 201Q61 206 62 211Q63 216 64 222Q79 231 105 247Q131 263 165 282Q181 291 197 295Q212 298 226 298ZM419 204L368 228L368 245L419 221L419 204ZM232 29Q232 29 233 29Q233 28 234 28Q244 25 253 26Q262 27 274 33Q278 36 334 68Q390 100 430 123L314 98Q312 95 309 92Q306 88 302 86L295 83Q295 83 295 83Q294 82 294 82L233 47Q230 46 227 45Q224 44 221 43L232 29ZM218 49Q221 50 224 51Q227 52 229 53L291 88Q292 89 293 90Q294 90 295 90Q298 93 300 96Q301 98 301 101Q301 104 299 108Q296 111 291 114L229 150Q224 153 218 155Q211 156 204 156Q197 156 190 155Q183 153 178 149L119 113Q115 110 113 107Q110 103 110 99Q110 95 113 92Q115 89 120 86Q120 86 120 86Q120 86 120 86L177 53Q178 53 179 53Q180 52 181 51Q186 49 192 48Q197 47 203 47Q207 47 211 48Q215 48 218 49ZM50 60Q63 51 77 45Q90 38 90 38L91 51Q80 57 69 64Q58 70 48 76Q46 72 46 68Q46 63 50 60ZM25 126Q25 126 25 126Q25 125 25 125Q25 122 29 118Q33 114 36 111Q70 91 114 67Q158 42 163 39Q171 36 181 36Q190 35 198 35Q201 35 204 35Q207 35 210 35L204 41Q196 41 188 43Q180 44 174 47L120 78L115 80Q107 84 103 92Q99 99 99 108Q98 115 102 121Q105 127 111 131L174 171Q180 175 189 177Q197 179 206 179Q214 179 222 177Q230 175 236 172L303 133Q308 129 312 125Q315 120 316 114L432 136Q432 136 432 137Q431 137 431 138Q422 140 414 140Q405 139 398 138Q391 137 385 137Q378 137 372 139Q360 145 345 152Q330 159 314 167L309 155Q309 155 307 152Q305 148 296 151Q287 154 265 168Q242 182 242 182Q242 182 241 183Q240 183 241 189Q241 193 241 198Q241 203 241 205Q231 212 228 222Q225 231 226 239Q219 239 213 237Q206 234 201 231Q195 228 186 223Q176 217 164 209Q133 191 93 168Q53 144 25 126ZM253 218L269 210Q294 197 325 181Q356 165 379 155Q382 154 386 155Q390 155 396 156Q400 156 405 157Q410 157 416 157L245 245L244 243Q244 243 243 233Q242 223 253 218ZM255 183Q267 174 281 168Q295 161 295 161L296 176Q287 181 278 186Q269 190 261 194L253 198Q251 195 251 191Q251 186 255 183ZM32 151Q60 168 95 189Q129 209 155 224Q167 232 177 238Q186 243 192 246Q198 250 207 253Q216 256 226 256Q227 256 228 256Q228 256 229 256Q232 256 235 255Q238 254 238 254L244 253L245 252L421 162L420 175L262 256Q261 256 237 264Q213 271 182 254Q165 244 136 227Q106 209 80 193Q65 184 54 177Q42 170 36 167Q35 162 34 158Q33 154 32 151ZM252 664Q252 664 248 666Q243 668 236 668L223 667Q222 666 221 666Q220 666 220 665Q207 658 195 650Q183 642 170 634Q156 625 141 616Q126 606 110 596Q108 588 106 568Q104 547 101 522Q98 490 93 449Q89 409 84 368Q79 326 74 288Q69 249 64 222Q63 216 62 211Q61 206 60 201Q60 200 60 199Q60 197 59 196Q59 195 59 194Q58 192 57 191Q61 194 66 197Q70 199 75 202Q101 218 131 236Q160 253 177 262Q190 269 202 272Q214 275 224 275Q242 275 254 270Q266 265 267 265L283 256L283 268L282 285L282 298L292 304L293 280L293 263L293 251L358 218L358 256L368 262L368 228L368 213L420 186L419 204L419 221L409 499Q405 501 401 505Q397 509 393 514Q381 533 377 557Q372 580 377 599Q346 616 300 640Q253 663 252 664ZM394 590Q394 596 396 602Q397 608 400 613Q400 613 401 614Q401 614 401 615Q403 617 405 620Q406 622 408 624Q406 623 405 623Q403 623 401 622Q400 622 398 621Q396 620 394 618Q392 617 390 615Q388 612 386 608Q385 606 384 603Q383 600 382 597Q378 579 382 557Q386 535 398 518Q401 514 404 511Q406 508 409 506Q415 502 420 501Q425 499 429 499Q425 501 421 506Q416 510 412 516Q411 517 410 519Q409 520 409 521Q400 537 396 556Q392 574 394 590ZM450 585Q450 586 450 587Q449 587 448 588Q442 597 435 600Q427 603 422 599Q420 598 418 596Q416 594 415 591Q409 580 411 564Q413 548 421 535Q424 531 427 529Q430 526 433 524Q440 521 446 523Q451 525 455 533Q456 535 457 538Q457 540 458 542Q460 552 458 564Q456 575 450 585ZM431 542Q430 543 429 544Q428 545 427 547Q422 554 421 564Q420 573 423 579Q424 582 426 583Q428 584 431 584Q434 585 437 583Q440 581 442 577Q447 570 449 561Q450 551 446 545Q444 540 440 540Q436 539 431 542Z"
const GLYPH_W = 480, GLYPH_H = 694

// The glyph's path, scaled by k. It only uses M, L, Q and Z.
function glyphPath(d, k) {
  const p = new Path()
  const n = d.match(/[MLQZ]|[\d.-]+/g)
  let i = 0
  const at = () => new Point(n[i++] * k, n[i++] * k)
  while (i < n.length) {
    const c = n[i++]
    if (c === "M") p.move(at())
    else if (c === "L") p.addLine(at())
    else if (c === "Q") { const ctrl = at(); p.addQuadCurve(at(), ctrl) }
    else p.closeSubpath()
  }
  return p
}

// The council's bin in a bin's colour: the outline filled with it, and the
// icon's lines over it in see-through black, which reads on light and dark
// backgrounds alike.
const DRAWN_H = 72 // drawn this tall, then scaled
const binPaths = { shape: glyphPath(BIN_GLYPH.slice(0, BIN_GLYPH.indexOf("Z") + 1), DRAWN_H / GLYPH_H),
                   lines: glyphPath(BIN_GLYPH, DRAWN_H / GLYPH_H) }
function binImage(b) {
  const ctx = new DrawContext()
  ctx.size = new Size(DRAWN_H * GLYPH_W / GLYPH_H, DRAWN_H)
  ctx.opaque = false
  ctx.respectScreenScale = true
  ctx.addPath(binPaths.shape)
  ctx.setFillColor(new Color(b.body))
  ctx.fillPath()
  ctx.addPath(binPaths.lines)
  ctx.setFillColor(new Color("#000000", 0.35))
  ctx.fillPath()
  return ctx.getImage()
}

// A bin, height points tall.
function addBin(stack, b, height) {
  const i = stack.addImage(binImage(b))
  i.imageSize = new Size(height * GLYPH_W / GLYPH_H, height)
  return i
}

function text(stack, value, font, color, scale = 0.6) {
  const t = stack.addText(value)
  t.font = font
  t.textColor = color ?? PRIMARY
  t.lineLimit = 1
  t.minimumScaleFactor = scale
  return t
}

function symbol(stack, name, color, size) {
  const s = SFSymbol.named(name)
  s.applyFont(Font.semiboldSystemFont(size))
  const i = stack.addImage(s.image)
  i.imageSize = new Size(size, size)
  i.tintColor = color
  return i
}

function header(stack, data) {
  const r = stack.addStack()
  r.centerAlignContent()
  if (data.stale) {
    symbol(r, "exclamationmark.triangle.fill", WARN, 11)
    r.addSpacer(4)
    text(r, "Can't reach the council", Font.semiboldSystemFont(12), WARN)
  } else {
    symbol(r, "trash.fill", ACCENT, 11)
    r.addSpacer(4)
    text(r, "Bin day", Font.semiboldSystemFont(13), ACCENT)
  }
}

function pill(stack, w) {
  const tone = TONES[w.tone]
  const p = stack.addStack()
  p.centerAlignContent()
  p.backgroundColor = tone.bg
  p.cornerRadius = 11
  p.setPadding(4, 8, 4, 10)
  symbol(p, w.icon, tone.fg, 11)
  p.addSpacer(5)
  text(p, w.act, Font.semiboldSystemFont(12), tone.fg, 0.8)
}

// Headline and date, left-aligned.
function hero(stack, w, size) {
  text(stack, w.hero, Font.boldRoundedSystemFont(size), PRIMARY, 0.5)
  text(stack, w.sub, Font.semiboldSystemFont(13), SECONDARY)
}

// Which bins, in words: "Black, brown & green".
function binList(bins) {
  const names = bins.map((b, i) => i ? b.name.toLowerCase() : b.name)
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : names[0]
}

// The bins going out, each with what goes in it underneath.
function binRow(stack, bins, height, column) {
  const r = stack.addStack()
  r.bottomAlignContent()
  for (const b of bins) {
    const c = r.addStack()
    c.layoutVertically()
    c.size = new Size(column, 0)
    const top = c.addStack()
    top.addSpacer()
    addBin(top, b, height)
    top.addSpacer()
    c.addSpacer(5)
    const label = c.addStack()
    label.addSpacer()
    text(label, b.what, Font.semiboldSystemFont(11), SECONDARY, 0.7)
    label.addSpacer()
  }
  return r
}

// A hairline across the widget.
function rule(stack) {
  const r = stack.addStack()
  r.backgroundColor = new Color("#8E8E93", 0.25)
  r.size = new Size(0, 1)
  r.addSpacer()
}

// The collections after the next one, one row each.
function upcoming(stack, cs) {
  for (const c of cs) {
    const r = stack.addStack()
    r.centerAlignContent()
    const d = r.addStack()
    d.size = new Size(92, 0)
    text(d, c.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
         Font.semiboldSystemFont(13), PRIMARY)
    d.addSpacer()
    const icons = r.addStack()
    icons.spacing = 3
    for (const b of c.bins) addBin(icons, b, 18)
    r.addSpacer(8)
    text(r, binList(c.bins), Font.mediumSystemFont(13), SECONDARY, 0.7)
    r.addSpacer()
  }
}

// The next time worth redrawing for: 7am (when "out by 7am" becomes "bring
// them in"), just after midnight, or in six hours anyway.
function nextRedraw() {
  const now = new Date()
  const marks = [new Date(Date.now() + 6 * 3600e3)]
  const seven = new Date(now.getFullYear(), now.getMonth(), now.getDate(), OUT_BY)
  if (seven > now) marks.push(seven)
  const midnight = addDays(now, 1)
  midnight.setHours(0, 1, 0, 0)
  marks.push(midnight)
  return new Date(Math.min(...marks))
}

function build(data, family) {
  const cs = collections(data.dates)
  if (!cs.length) throw new Error("No collections in the next few weeks")
  const next = cs[0]
  const w = when(next)
  const widget = new ListWidget()
  widget.url = COUNCIL_URL
  widget.refreshAfterDate = nextRedraw()

  if (family === "accessoryInline") {
    widget.addText(`${w.short}: ${binList(next.bins)} bin${next.bins.length > 1 ? "s" : ""}`)
    return widget
  }
  if (family === "accessoryCircular") {
    // One tint only, so the bins are counted with dots.
    widget.addAccessoryWidgetBackground = true
    const s = widget.addStack()
    s.layoutVertically()
    s.centerAlignContent()
    const row = (fn) => { const r = s.addStack(); r.addSpacer(); fn(r); r.addSpacer() }
    row((r) => symbol(r, "trash.fill", Color.white(), 11))
    row((r) => text(r, w.short, Font.boldRoundedSystemFont(15), Color.white(), 0.5))
    row((r) => text(r, "●".repeat(next.bins.length), Font.systemFont(7), Color.white()))
    return widget
  }
  if (family === "accessoryRectangular") {
    const top = widget.addStack()
    top.centerAlignContent()
    symbol(top, "trash.fill", Color.white(), 12)
    top.addSpacer(4)
    text(top, w.days >= 7 ? w.short : w.hero, Font.boldRoundedSystemFont(15), Color.white())
    text(widget, binList(next.bins), Font.semiboldSystemFont(13), Color.white(), 0.7)
    const then = cs[1]
    if (then) text(widget, `Then ${binList(then.bins).toLowerCase()} · ${then.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}`,
                   Font.systemFont(12), Color.white(), 0.7)
    return widget
  }

  widget.backgroundColor = BG

  if (family === "small" || !family) {
    widget.setPadding(14, 14, 12, 14)
    header(widget, data)
    widget.addSpacer(6)
    hero(widget, w, 26)
    widget.addSpacer()
    // The bins going out, as big as fit the height.
    // A bin on its own gets its name and contents beside it.
    const n = next.bins.length
    const row = widget.addStack()
    row.bottomAlignContent()
    row.spacing = n > 3 ? 4 : 6
    for (const b of next.bins) addBin(row, b, n > 3 ? 34 : 42)
    if (n === 1) {
      const b = next.bins[0]
      const label = row.addStack()
      label.layoutVertically()
      text(label, `${b.name} bin`, Font.semiboldSystemFont(13), PRIMARY)
      text(label, b.what, Font.mediumSystemFont(12), SECONDARY)
      label.addSpacer(3)
    }
    row.addSpacer()
    widget.addSpacer(8)
    pill(widget, w)
    return widget
  }

  // Medium and large: the header and what to do across the top, then when
  // on the left and the bins going out on the right, then what's after.
  widget.setPadding(14, 16, 14, 16)
  const top = widget.addStack()
  top.centerAlignContent()
  header(top, data)
  top.addSpacer()
  pill(top, w)
  const large = family === "large"
  if (large) widget.addSpacer(16)
  else widget.addSpacer()
  const row = widget.addStack()
  row.bottomAlignContent()
  const left = row.addStack()
  left.layoutVertically()
  hero(left, w, 30)
  left.addSpacer(2)
  row.addSpacer()
  // Medium is short enough that the bins give up a little height to fit
  // the strip underneath.
  const n = next.bins.length
  const tall = large ? (n > 3 ? 46 : n > 1 ? 56 : 62) : (n > 3 ? 40 : n > 1 ? 48 : 52)
  binRow(row, next.bins, tall, n > 3 ? 44 : 56)

  if (!large) {
    // The next three collections after this one, side by side.
    widget.addSpacer()
    rule(widget)
    widget.addSpacer(8)
    const strip = widget.addStack()
    strip.centerAlignContent()
    cs.slice(1, 4).forEach((c, i) => {
      if (i) strip.addSpacer()
      const icons = strip.addStack()
      icons.spacing = 2
      for (const b of c.bins) addBin(icons, b, 16)
      strip.addSpacer(6)
      text(strip, c.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
           Font.semiboldSystemFont(12), SECONDARY, 0.8)
    })
    return widget
  }

  // Large adds the collections after this one as a list.
  widget.addSpacer(18)
  rule(widget)
  widget.addSpacer(14)
  text(widget, "COMING UP", Font.semiboldSystemFont(11), SECONDARY)
  widget.addSpacer(10)
  const list = widget.addStack()
  list.layoutVertically()
  list.spacing = 12
  upcoming(list, cs.slice(1, 7))
  widget.addSpacer()
  return widget
}

function failed(message) {
  const w = new ListWidget()
  w.backgroundColor = BG
  const t = w.addText(`Bins: ${message}`)
  t.font = Font.systemFont(11)
  t.textColor = SECONDARY
  w.refreshAfterDate = new Date(Date.now() + 3600e3)
  return w
}

const FAMILY = config.widgetFamily ?? args.queryParameters.size ?? "medium"
let widget
try {
  widget = build(await loadOrCached(), FAMILY)
} catch (e) {
  widget = failed(e.message)
}
if (config.runsInWidget) Script.setWidget(widget)
else if (FAMILY === "small") await widget.presentSmall()
else if (FAMILY === "large") await widget.presentLarge()
else await widget.presentMedium()
Script.complete()
