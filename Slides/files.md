# Speaking Script — Caidic Hardware POS Project Update

This is a talking guide, not a word-for-word script. Read it over once before the
meeting, then speak naturally — use your own words, this just keeps you on track.

**Before you start:** have the slides open, and have the live demo (`app.html`) open
in a separate tab, ready to switch to for item 3.

---

## 1. Welcome and Purpose — 5 min
**[Show Slide 1 — Title]**

"Thank you both for making time today. Over the past few weeks I've been building
the checkout and inventory system for the store. Today I want to walk you through
what's ready, show you how it actually works, and get your feedback before we go
further."

**[Show Slide 2 — Agenda]**

"Here's how we'll spend our time — six things, about an hour total."

---

## 2. Why We Started This Project — 5 min
**[Show Slide 3 — The Problems We're Solving]**

"Before I show you what's built, it's worth remembering why we're doing this.

Counting stock by hand takes time, and it's easy to lose track of what's actually
on the shelf.

The internet at the store isn't always reliable, and a checkout system that stops
working the moment the connection drops isn't good enough.

And a lot of point-of-sale systems charge a fee every single month just to keep
running. That's an ongoing cost we wanted to avoid if we could.

Everything I'm about to show you was built with those three problems in mind."

---

## 3. Live System Walkthrough — 20 min
**[Show Slide 4 — What's Ready Today, as a quick lead-in]**

"Let me show you the four main pieces that are working right now — rather than
just describe them, let me open the actual system."

**[Switch to the live demo now]**

**Staff login**
"This is the login screen your cashiers will see. Instead of typing a username and
password, they tap their name..." *(tap a cashier)* "...and enter their 4-digit
code."

**Ringing up a sale**
"Now I'm logged in as a cashier. This is the checkout screen. I can scan a
barcode, search by name, or tap an item here..." *(add a couple of items)*
"...and it builds the order as we go."

**Inventory updates automatically**
"Watch the stock count when I complete this sale." *(complete the sale)* "Now if I
go to Inventory..." *(switch views)* "...the stock for that item already went
down. No one has to recount it by hand."

**Works offline**
"One more thing I want you to see — this also works if the internet goes down."
*(toggle the status pill to Offline)* "Checkout still works exactly the same.
Sales get saved here first, then sent to the cloud automatically once the
connection is back. Your cashiers would never notice a difference."

**Owner-only access**
"Now let me log out and back in as an owner." *(switch users)* "Owners see
everything cashiers see, plus one more section — Staff Accounts — where you can
add new staff, reset a PIN, or turn off someone's access if they leave."

---

## 4. How This Protects Your Business — 10 min
**[Show Slide 8 — Built-In Accountability]**

"Two things here were built specifically to protect you and catch mistakes —
honest ones or otherwise.

First, how cash counts work at the end of a shift. When a cashier closes out,
they count the drawer *before* the system tells them what it expects to see. That
way the count is honest — they're actually counting, not just matching a number.

Second, a permanent activity record. Every important action — voiding a sale
that's already been paid, adjusting stock — gets logged automatically. That
record can never be edited or deleted. Not by a cashier, not by a manager, not
even by you as the owner. If something looks wrong later, you'll always be able
to see exactly what happened, when, and who did it."

---

## 5. Running Costs — 5 min
**[Show Slide 9 — FREE]**

"This is probably the part you'll like best. At your store's current size, this
costs nothing to run every month. Hosting and the database are both free. If the
business grows a lot down the road — say, a second branch — a small fee might
apply later, but that's not a concern right now."

---

## 6. What's Left to Build — 5 min
**[Show Slide 10 — What's Left to Finish]**

"To be upfront about where things stand, three things are still left:

Printing actual paper receipts, connecting to a real receipt printer.
Sales reports — a screen showing your best-selling items and daily totals.
And connecting this screen to your real, live data — what you saw today was
sample products for the demo.

None of these change how anything you saw today works. They're additions, not
fixes."

---

## 7. Questions and Feedback — 10 min

"That's everything I wanted to cover. What questions do you have? And please,
tell me honestly if anything felt confusing, or if there's something you'd want
done differently before we move forward."

*(Leave real space here. Let them talk — don't fill the silence.)*

---

## 8. Next Steps and Sign-Off — 5 min
**[Show Slide 11 — Thank You]**

"Thank you again for your time today. Before we wrap up, let's confirm two
things: any decisions we landed on today, and when we should meet next to check
in on progress."

*(Fill in the Notes section of the agenda together, live, before they leave.)*

---

## A few reminders for yourself

- Keep the screen turned so both Eleazer and Toni can see it clearly.
- Don't rush item 3 — the live walkthrough is what will land most with them.
  Slides explain it; seeing it work is what builds confidence.
- If a question comes up you can't answer on the spot, it's fine to say "let me
  check on that and follow up" rather than guessing.
- Avoid technical words in the moment (database, sync, cache, API). If you slip
  and use one, just follow it with what it means in plain terms.
