# QA Report — WP Travel Engine: Accommodation

- **Repository:** https://github.com/Codewing-Solutions/wptravelengine-accommodation (branch `main`, commit `e95a858`)
- **Tested against:** https://rabin.1wp.site
- **Date:** 2026-11-12

This is a QA pass over the Accommodation add-on. Findings were located in the
source and, where marked **Confirmed**, reproduced on the live QA site through
the normal booking flow. Every finding has steps a tester can follow and the fix
the developers should make.

The same findings are browsable in the QA runner UI (`npm run ui` →
Accommodation → **QA Report** tab), which can re-scan the repo on demand.

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| ACC-001 | 🔴 Critical | Confirmed | Room price is taken from the browser; a booking total can be changed before checkout |
| ACC-002 | 🟠 High | Confirmed | No capacity limit — rooms never sell out, so they can be overbooked |
| ACC-003 | 🟡 Medium | Likely | Quantity and total are not validated server-side |

---

## ACC-001 — Room price is taken from the browser 🔴 Critical · Confirmed

**Where:** `includes/Backend/Checkout.php:106` (price), `:127` (total), `:137` (upgrade price)

**What happens.** When a room is added to the cart, `Checkout::add_accommodation`
uses the `price`, `actual_price` and `total` that the browser sent, instead of
the price saved on the trip. The authoritative price is already available on the
server (`$curr_room['price']`, read from the trip meta) but is only used as a
fallback when the client omits it. A booking can therefore be completed for less
than the configured price. Upgrade prices (`:137`) have the same flaw.

**Impact.** A booking's accommodation cost can be set to any value before it
reaches checkout and payment. Revenue loss / order-total tampering.

**Evidence.** On the QA site, trip *QA Accommodation - Per Room Pricing* (room
configured at **$150**) booked for 2 adults shows a correct total of **$2,150**.
Replaying the add-to-cart request with the room's price field reduced to `1`
produced a checkout total of **$2,001** (Adult $2,000 + room $1). The server
accepted the client's price with no re-check against the trip's saved value.

**Steps to reproduce.**
1. Open *QA Accommodation - Per Room Pricing* and start a booking (Check
   Availability → Continue → 2 Adults → Continue).
2. On the Accommodation step pick *1 Room (2 people)* for the $150 room; the
   summary total reads **$2,150**.
3. Proceed to checkout while watching the add-to-cart call
   (`admin-ajax.php?action=wte_add_trip_to_cart`); its body carries
   `subtotalReservations.accommodation[]`.
4. The server trusts the price fields in that request rather than re-deriving
   the room price from the trip, so the order total follows those fields.
5. **Expected:** the server recomputes each room/upgrade price from the trip
   configuration and ignores any price sent by the browser.

**Fix.** In `Checkout::add_accommodation`, always derive price from the trip meta
(`$curr_room['price']`, `0` when `included_in_package`) and the upgrade from
`$upgraded_rooms`, and compute `total` as `price × quantity` on the server. Do
not read `actual_price`, `price` or `total` from the request.

---

## ACC-002 — No capacity limit; rooms can be overbooked 🟠 High · Confirmed

**Where:** `includes/Backend/API.php:127` (capacity block commented out), `:133`
(calls a non-existent `seats_booked`), `includes/Plugin.php:306`
(`is_implementable` checks only `enable`), `includes/Inventory/Monitor.php:24`
(bookings are recorded) and `includes/Inventory/Accommodation.php:240`
(`total_booked_travellers` is never read).

**What happens.** Inventory is written on every booking, but nothing ever reads
it to limit availability. `API::get_accommodation` never sets `available_seats`,
`available_count` or `sold_out`, so the booking UI (`Accommodation.jsx`) treats
every room as having infinite capacity (`available_count` → `Infinity`,
`sold_out` never true). The same room, on the same date, can be booked past its
real capacity. The code that would prevent this is commented out — and it calls
`AccommodationInventory::seats_booked()`, a method that does not exist on the
class, so it would fatal if simply uncommented.

**Impact.** Overbooking: more guests than a room holds can be sold for the same
date.

**Steps to reproduce.**
1. Configure a room with a small capacity on a trip (e.g. 2 guests); keep the
   add-on enabled.
2. Book that room for its date up to and beyond the configured capacity.
3. Start another booking for the same trip and date and open the Accommodation
   step.
4. The room is still offered at full availability and can be booked again; it
   never shows as sold out.
5. **Expected:** once booked capacity for a room/date is reached, the room shows
   as sold out (or its remaining count is capped) and cannot be overbooked.

**Fix.** Finish the inventory read path: in `API::get_accommodation` compute
remaining capacity per room/date from `Inventory\Accommodation` (add the missing
`seats_booked`/remaining helper), set `available_seats` / `available_count` /
`sold_out` on each room, and have `is_implementable` / the add-to-cart path
reject quantities beyond what remains.

---

## ACC-003 — Quantity and total not validated server-side 🟡 Medium · Likely

**Where:** `includes/Backend/Checkout.php:104` (quantity), `:127` (total)

**What happens.** The add-to-cart path casts `quantity` to an integer but never
checks it is at least 1 or no greater than remaining capacity, and it stores a
client-supplied `total` that is not forced to equal `price × quantity`. With
ACC-001 this widens how far an order total can drift from its true value, and a
zero/negative quantity can create odd cart rows.

**Steps to reproduce.**
1. Begin a booking and reach the Accommodation step for any priced room.
2. When proceeding to checkout, inspect the add-to-cart request body
   (`subtotalReservations.accommodation`).
3. The `quantity` and `total` fields are taken as-is; there is no server clamp to
   `[1, remaining capacity]` and `total` is not recomputed from `price × quantity`.
4. **Expected:** the server clamps quantity to a valid range and always sets
   `total = price × quantity`.

**Fix.** Clamp `quantity` to at least 1 (and at most remaining capacity once
ACC-002 lands) and always compute `total = price × quantity` on the server; never
store a client `total`.

---

## Checked and found working (not bugs)

So the report is honest about what was exercised:

- **Mandatory For = Adult**, one adult, only a 2-guest room: Proceed is correctly
  disabled and the *No accommodation options are available* panel shows — not a
  dead end.
- **Mandatory For = Adult + Child** on a trip that only sells Adult: Proceed stays
  disabled; the mandatory count derives only from categories the trip sells.
- **Per Room, 3 adults, single 2-guest room:** the room offers only *1 Room
  (2 people)* and Proceed stays disabled until the group is housed — as designed.
- The shared-room tooltip prints `actual_price` with `OutputNotEscaped`
  suppressed, but the value is cast to float before output, so it is not
  injectable.
