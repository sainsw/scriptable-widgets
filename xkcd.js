// Scriptable name: Today's xkcd Comic
// Shows the latest xkcd comic, and nothing else, in a widget. Tapping it
// opens the comic on xkcd.com, where the hover text is.

const comic = await new Request("https://xkcd.com/info.0.json").loadJSON()

// Most comics have a sharper double-size version alongside; use it when
// there is one.
async function image(url) {
  try {
    const req = new Request(url.replace(/\.(png|jpg)$/, "_2x.$1"))
    const img = await req.loadImage()
    if (req.response.statusCode === 200) return img
  } catch {}
  return new Request(url).loadImage()
}

// The comic reshaped to the widget's width:height, so it can fill the widget
// edge to edge. It always spans the full width: a tall comic is cut off at
// the bottom (keeping its first panels), and a wide one gets white above
// and below.
const FAMILY = config.widgetFamily ?? "large"
const ASPECT = { small: 1, medium: 364 / 170, large: 364 / 382, extraLarge: 715 / 338 }[FAMILY] ?? 1
function fitToWidget(img) {
  const { width, height } = img.size
  const ctx = new DrawContext()
  ctx.size = new Size(width, width / ASPECT)
  ctx.respectScreenScale = false
  ctx.setFillColor(Color.white())
  ctx.fillRect(new Rect(0, 0, width, width / ASPECT))
  ctx.drawImageAtPoint(img, new Point(0, Math.max(0, (width / ASPECT - height) / 2)))
  return ctx.getImage()
}

const w = new ListWidget()
// xkcd is drawn black on white, so it stays on white in dark mode too.
w.backgroundColor = Color.white()
w.setPadding(0, 0, 0, 0)
w.url = `https://xkcd.com/${comic.num}/`
// New comics come out on Mondays, Wednesdays and Fridays.
w.refreshAfterDate = new Date(Date.now() + 3 * 3600e3)
const img = w.addImage(fitToWidget(await image(comic.img)))
img.applyFillingContentMode()

if (config.runsInWidget) Script.setWidget(w)
else if (FAMILY === "small") await w.presentSmall()
else if (FAMILY === "medium") await w.presentMedium()
else await w.presentLarge()
Script.complete()
