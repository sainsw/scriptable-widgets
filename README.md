# Scriptable widgets

Widgets for [Scriptable](https://scriptable.app), a free iOS app that runs
JavaScript widgets. Each is one script that talks straight to the service
it shows, so there's nothing to deploy.

| Script | In Scriptable | Shows |
| --- | --- | --- |
| [bin-day.js](bin-day.js) | *Bin Day* | Manchester's next bin collection, and which bins go out |
| [toyota.js](toyota.js) | *Toyota* | Your car's charge or fuel, range, and whether it's locked |
| [toyota-endpoints.js](toyota-endpoints.js) | *Toyota Endpoints* | Not a widget: every Toyota endpoint's raw response, for poking at |
| [xkcd.js](xkcd.js) | *Today's xkcd Comic* | The latest xkcd |

## Bin day

[bin-day.js](bin-day.js) shows Manchester City Council's next bin
collection, and which bins go out for it, each drawn as the council's own
isometric wheelie bin (the icon from its site's `mcc-icons` font) in the
bin's colour:

| Bin | What goes in it |
| --- | --- |
| **Black** (the council calls it grey) | Rubbish |
| **Blue** | Paper and card |
| **Brown** | Glass, cans and plastic bottles |
| **Green** | Garden and food waste |

The headline says when (*Tomorrow*, *Friday*, *9 Oct*), and a pill says what
to do about it: *Put out tonight* the day before, *Out by 7am* on the
morning, *Bring them in* once they've been collected, and *In 4 days*
otherwise. Medium adds a strip along the bottom with the next three
collections after it, and large lists the next six. On the lock screen,
rectangular gives the day, the bins and the collection after; circular gives
the day and a dot per bin; inline is one line.

It asks the council's own bin checker (the one behind
[manchester.gov.uk/bincollections](https://www.manchester.gov.uk/bincollections)),
the same way [UKBinCollectionData](https://github.com/robbrad/UKBinCollectionData)
does, so it needs no token. The dates are kept on the phone and fetched again
every six hours; if the council can't be reached the kept ones are used, with
a warning once they're over a week old. Tapping it opens the council's bin
page.

To set it up, find your UPRN (the council's number for your address) by
searching your postcode at [findmyaddress.co.uk](https://www.findmyaddress.co.uk),
then run the script once in Scriptable and paste it in. It's kept in the
Keychain as `bin_day_uprn`, so your address isn't in the file.

## Toyota

[toyota.js](toyota.js) shows your car from the MyToyota app, which has no
widgets of its own: how much charge or fuel it has, how far that gets you,
whether it's locked, and anything left open. It works out what to show from
the car:

- **Electric cars** show their battery.
- **Plug-in hybrids** show the part of their battery you can drive on (as
  the MyToyota app does), with a second bar for fuel underneath. The range
  is on both together, then electric only: *405 mi range, 25 mi EV*. When the
  usable battery is empty the car is just driving as a hybrid, so the number
  shows its fuel instead (with *Hybrid mode*), until it's charging again.
- **Everything else** shows fuel.

The bars are Apple's system green for electric and orange for fuel. The
number is green while charging, orange at 20% and red at 10%.

| Size | Shows |
| --- | --- |
| **Small** | The car, the level with its bars, range (or time left charging), a lock, and where it's parked |
| **Medium** | Adds the car's name, when it last reported, and *Locked · All shut* (orange when it's unlocked or something's open) |
| **Large** | A bigger picture of the car, the mileage, and tiles for where it's parked, locks, the last drive, and the month so far |
| **Lock screen** | A ring for the level (circular), the level with the lock state (rectangular), or one line |

Where it's parked is the street, or *Parked at home* near the spot you've
saved as home: run the script in Scriptable and pick *Set home to where it's
parked* while the car's there (it's kept in the Keychain as
`toyota_widget_home`). Running it in the app also previews each size.

Give a small or medium widget the parameter `trips` (long-press → **Edit
Widget** → **Parameter**) for driving instead: the month's distance with a
bar for how much of it was electric, mpg (or L/100km), and the last drive,
with medium adding Toyota's score for it and where the car's parked now.

The time is when the car last reported, not when the widget last ran: a
parked car doesn't report. Tapping it opens the MyToyota app, through the
`com.toyota.oneapp://` link its login uses.

Toyota has no public API, so it uses the app's own, the way
[pytoyoda](https://github.com/pytoyoda/pytoyoda) (behind the Home Assistant
integration) does. That's unofficial, and Toyota moves these endpoints every
so often; when the widget starts failing, pytoyoda's recent changes are the
place to look. The last reports are kept on the phone, so if Toyota can't be
reached they're shown with *Can't reach Toyota*, or *Log in to Toyota again*
if the login has stopped working.

To set it up, run the script once in Scriptable and log in with your
MyToyota email and password. They're kept in the Keychain as
`toyota_widget_login` (the session is `toyota_widget_tokens`), and only used
to log in again when Toyota's session lapses. To log in as someone else,
remove both with `Keychain.remove(…)` and run it again. At the top of the
script, `UNITS` is `mi` or `km`, and `VIN` picks a car if the account has
more than one.

## xkcd

[xkcd.js](xkcd.js) shows the latest [xkcd](https://xkcd.com) and nothing
else, edge to edge: the comic is made the widget's shape, so it always runs
the full width, with a tall one cut off at the bottom (keeping its first
panels) and a wide one getting white above and below. It uses the sharper
double-size image when there is one. Tapping it opens the comic on xkcd.com,
where the hover text is.

## Setup

1. **Scriptable.** Install Scriptable from the App Store. Then, from a Mac
   signed in to the same iCloud account, run `./install.sh`: it copies every
   script here into Scriptable's iCloud Drive folder, keeping their icons,
   and they reach the phone within a minute or so. Run it again after any
   change. (Or create a script in Scriptable and paste one in.)
2. **Run it once in the app**, for the ones that need something from you:
   *Bin Day* asks for your UPRN and *Toyota* for your MyToyota login.
3. **Add the widget.** Long-press the home screen (or the lock screen →
   **Customize**), add a Scriptable widget, then long-press it → **Edit
   Widget** → pick the script.

`install.sh` names each script from its filename (`bin-day.js` becomes *Bin
Day*), unless it has a `// Scriptable name: …` line, as `xkcd.js` does to
keep the name its widget already uses.

iOS decides when widgets refresh, usually every 15 to 60 minutes, so they're
for a glance rather than a live view. They also show on the Mac desktop
(macOS Sonoma+): right-click the desktop → **Edit Widgets** → *From iPhone*.
