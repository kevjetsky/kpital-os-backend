# Online booking

The We-Fix-Consoles website's "Book online" page (`/book` in
we-fix-consoles-frontend-simple) books visits through this backend. It moved
here from a separate Cloudflare Worker (kpital-os-mcp, branch
`feature/booking-beta`), which is now switched off.

## How it works

- **Availability is the Slot Finder** (`src/slotFinder/service.js`): the
  owner's slot grid, buffer, home base and "home by" time from the Slot Finder
  settings, Google Calendar events, jobs booked in Kpital OS with a time, and
  Google Routes drive times. Booking adds three customer-facing rules on top
  (`src/booking/availability.js`): a 90-minute lead time, the last slot only
  with a short drive home (20 minutes, applied through "home by"), and online
  holds count as busy time.
- **Days list**: only days with at least one window that fits the customer's
  address on that day's route.
- **Drive times** are priced for a "typical day" (every leg at the same time of
  day tomorrow), so a week of days shares answers: a new address costs about
  20 to 30 Routes elements. The booking page stops at
  `BOOKING_MAPS_DAILY_CAP` elements a day because it shares the Google
  project's daily Routes limit with the Slot Finder (`src/booking/drive.js`).
- **Addresses**: suggestions and lookups use the same free Census + Photon code
  as the record form (`src/services/geoService.js`).
- **Holds** live in MongoDB (`bookinglocks`) with a unique (account, slot)
  index, so two customers cannot take one time on any instance. A hold lasts 10
  minutes; a booked time is locked for 5 minutes, after which the calendar
  event decides.
- **A booking** becomes a Google Calendar event on the owner's calendar (title
  "Service - Name", the address as location, blueberry, a 60-minute reminder,
  phone/device/service/notes/booking ID in the description) and a `bookings`
  record. The owner gets a push notification on their Kpital OS devices and an
  email.

## API

Public, for the website (`src/booking/routes.js`, mounted at
`/api/public/booking` with its own CORS for the website origins):

| Route | What |
| --- | --- |
| `GET /status` | enabled flag and which parts are live |
| `POST /suggest` `{ q }` | address suggestions as the customer types |
| `POST /check-area` `{ address, turnstileToken }` | in the service area? returns a 30-minute `areaToken` |
| `GET /days?areaToken=` | days with a window that fits, and how many |
| `GET /slots?areaToken=&date=[&holdId=]` | a day's windows |
| `POST /hold` `{ areaToken, start, replaceHoldId? }` | hold a window for 10 minutes |
| `POST /book` (header `Idempotency-Key`) | book a held window |

Owner, signed in (`src/routes/bookings.js`): `GET /api/bookings` and
`POST /api/bookings/:bookingId/cancel` (removes the calendar event). From a
shell, with the deployment's environment:
`node scripts/cancel-booking.mjs WFC-XXXXXX`.

## Settings

Booking is off unless `BOOKING_ENABLED=true`. It also needs the Slot Finder's
`GOOGLE_CALENDAR_*`, `GOOGLE_CALENDAR_ACCOUNT_ID` and `GOOGLE_MAPS_API_KEY`.
**The calendar refresh token must include the `calendar.events` scope** to add
events (the Slot Finder alone only needs `calendar.readonly`).

| Variable | Default | |
| --- | --- | --- |
| `BOOKING_ENABLED` | `false` | kill switch |
| `BOOKING_AREA_TOKEN_SECRET` | none, required | signs the areaToken (any long random string) |
| `BOOKING_ALLOWED_ORIGINS` | we-fix-consoles.com, www | browser origins allowed |
| `BOOKING_ALLOWED_ORIGIN_SUFFIXES` | none | e.g. `.we-fix-consoles.pages.dev` for previews |
| `BOOKING_TURNSTILE_SECRET` | none (check skipped) | Cloudflare Turnstile secret |
| `BOOKING_MAPS_DAILY_CAP` | 500 | Routes elements a day |
| `BOOKING_WINDOW_DAYS` | 7 | how far ahead customers can book |
| `BOOKING_MIN_LEAD_MINUTES` | 90 | |
| `BOOKING_LAST_SLOT_MAX_DRIVE_HOME_MIN` | 20 | |
| `BOOKING_MAX_DRIVE_MIN` | 45 | service area: drive from home base |
| `BOOKING_SERVICE_AREA_GEOJSON` | none | optional polygon (GeoJSON) |
| `BOOKING_HOLD_MINUTES` / `BOOKING_JOB_MINUTES` | 10 / 60 | |
| `BOOKING_MAX_ACTIVE_PER_PHONE` / `BOOKING_MAX_PER_ADDRESS_PER_DAY` | 2 / 1 | |
| `BOOKING_CALENDAR_ID` | `GOOGLE_CALENDAR_ID` or primary | where events go |
| `BOOKING_EMAIL_SUBJECT_PREFIX` | empty | e.g. `[BETA] ` |
| `BOOKING_EMAIL_FROM` | none | customer confirmation sender; customer email is only sent when set |
| `BOOKING_RATE_*` | 10/h check-area, 150/h suggest, 30/h days+slots, 10/h hold, 3/day book | per client address |

Email: the owner email uses `RESEND_FROM_EMAIL`. While that is Resend's
sandbox sender (`onboarding@resend.dev`), Resend only delivers to the email
that owns the Resend account, so verify a domain in Resend and use a sender on
it. The customer SMS copy is logged until sent.dm is wired.

## The test version

An App Engine version named `booking-beta`, deployed **without** traffic:
https://booking-beta-dot-kpital-os.uc.r.appspot.com. It runs this branch with
the production config plus the booking settings and a calendar token that has
`calendar.events`; that config is the Secret Manager secret
`backend-booking-beta-app-yaml`. It shares the production database (booking
uses only the four `booking*` collections) and the production push/email
settings. The website's preview (`npm run build:beta`,
https://booking-beta.we-fix-consoles.pages.dev) points at it.

Redeploy it from this branch:

```bash
gcloud secrets versions access latest --secret=backend-booking-beta-app-yaml --project=kpital-os > app.booking-beta.yaml
gcloud app deploy app.booking-beta.yaml --project=kpital-os --version=booking-beta --no-promote --quiet
rm app.booking-beta.yaml
```

Never drop `--no-promote`: without it the version takes all live traffic.

## Going live

1. Add the `BOOKING_*` variables to the production config (Secret Manager
   `backend-app-yaml`) and replace `GOOGLE_CALENDAR_REFRESH_TOKEN` with one that
   has `calendar.events` (the one in `backend-booking-beta-app-yaml` works; it
   also covers the Slot Finder's reads). Use real Turnstile keys.
2. Merge this branch to main; CI deploys it.
3. Build the website with `NEXT_PUBLIC_BOOKING_API=https://api.kpitaltech.com/api/public/booking`
   and the real Turnstile site key, and deploy it.
4. Delete the `booking-beta` App Engine version.
