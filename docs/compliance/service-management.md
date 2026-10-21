# Service and quality management

How the POS is run as a service (ISO/IEC 20000-1) and how its quality is
kept and improved (ISO 9001).

## The service

**RRC Merchandise POS:** the store's register and back office. Cashiers sell
(cash, GCash / PayMaya, credit), take credit payments and work the pick
lists. Owners also manage stock, sales, shifts, returns, staff and the Audit
log. It runs during store hours on the store's devices, and works offline.

It has three parts: the app (published on GitHub Pages), the database and
server functions (Supabase), and the devices.

## Service levels

| Measure | Target | Where it's seen |
|---|---|---|
| Selling available during store hours | Always (it works offline) | Incident issues |
| A sale reaches the server | Within a minute when online | The status pill; the Sales screen |
| Owner screens available during store hours | 99% (they depend on Supabase) | Daily health check under **Actions**; incident issues |
| First response to a problem | Same day if it stops selling or involves money or personal data; within a week otherwise | Incident issues |
| Backups | Every night; a restore tested every quarter | **Actions → Nightly backup**; [exercise record](business-continuity.md#exercise-record) |

## Requests

| Request | Who | How |
|---|---|---|
| New cashier account | Owner | **Staff → Add a cashier** |
| New owner account | Owner with Supabase access | SQL Editor: `select pos.add_staff('Name', 'owner', '123456');` ([DEPLOY.md](../../DEPLOY.md#owner-accounts)) |
| Reset a cashier's password | Owner | **Staff → Edit** |
| Reset an owner's password, or turn off their two-factor login (lost phone) | Owner with Supabase access | SQL Editor: `pos.reset_password`, `pos.turn_off_two_factor` ([DEPLOY.md](../../DEPLOY.md#owner-accounts)) |
| Two-factor login for an owner | That owner | **Staff → Edit** on their own account **→ Set up** |
| Replace a device's key (seen by someone it shouldn't have been) | Owner | SQL Editor: `pos.add_terminal`, then retire the old key; the device asks for the new one |
| Remove someone's access | Owner | **Staff → Deactivate** (signs them out everywhere at once) |
| Set up a new device | Owner | SQL Editor: `select pos.add_terminal('Device name');`, then enter the key on the device |
| Retire a device | Owner | **Table Editor → terminals →** set `is_active` to `false` |
| New item, price or count | Owner | **Stock** |
| Remove a customer's details | Owner | [policies.md](policies.md) §8 |
| Report a problem | Anyone | Tell an owner, who records it as a GitHub issue |

## Incidents and problems

An **incident** is anything that stopped or went wrong. Security incidents
follow [policies.md](policies.md) §7; other faults follow the same steps.
Each one is recorded as a GitHub issue with the **Problem or incident**
template.

| Priority | Meaning | Respond |
|---|---|---|
| 1 | Selling stopped, or money or personal data affected | Same day |
| 2 | An owner screen or sync not working | Next day |
| 3 | Anything else | Within a week |

A **problem** is the cause behind incidents. When the same incident happens
twice, or the cause isn't clear, the owners find the cause, fix it, and link
the related issues.

## Changes and releases

1. Every change is made in the repository: a branch and a pull request for
   anything more than a small fix.
2. The pull request runs the full test suite (the **test** job of **Deploy to
   GitHub Pages**). With `main` protected, it can't be merged unless the tests
   pass.
3. Merging to `main` publishes it: tests, then the build (which also blocks
   packages with known high-severity vulnerabilities), then the deploy. Each
   Actions run is the record of that release.
4. **Database changes** go in a new dated file in `supabase/migrations`
   (tables), or in the API file (functions, which are all `create or
   replace`). Try them on a test Supabase project first, then run them in the
   live project's SQL Editor before, or right after, merging the app change
   that needs them, and say so in the pull request.
5. **Undoing a change:** revert its commit, which publishes the previous
   version. For the database, add a migration that reverses it, or restore.
6. Urgent fixes follow the same path; the tests still run.

## Suppliers

| Supplier | Service | Status | Plan |
|---|---|---|---|
| Supabase | Database and server functions (Singapore region) | status.supabase.com | Free |
| GitHub | Code, Actions, Pages, backup storage | www.githubstatus.com | Free (public repository) |

Both publish their security reports and certifications on their trust
pages. Keep dated copies, with their terms, and review them every year
([policies.md](policies.md) §9).

## Capacity and availability

- **Monthly:** in Supabase, open the project's **Usage** page and compare the
  database size and traffic with the plan's limits (the current limits are on
  Supabase's pricing page). Upgrade before reaching them.
- A free project pauses after a week without use. A store open every day
  won't hit this; if it happens, restore it from the dashboard.
- Availability is checked every day by the **health** job of **Actions →
  Nightly backup**, which emails the repository owner if it fails.

## Quality management (ISO 9001)

### Quality objectives

| Objective | Measure | Target |
|---|---|---|
| Correct records | Releases that pass all automated checks | 100% (enforced) |
| Reliable selling | Sales lost because of the system | None |
| Problems fixed quickly | Priority 1 issues resolved the same day | All |
| Money controls work | Unexplained cash differences or voids open for more than a week | None |

### How the work is controlled

- **Requirements:** the store's rules (roles, two-owner voids, blind cash
  counts, offline selling) are written in this folder, in the code's
  comments, and as tests.
- **Verification:** 500+ automated checks in `tests/` run on every change:
  the server functions on a real PostgreSQL database, the app's sync code
  through a full store day, the offline cache, and the screens themselves,
  used in a simulated browser (selling, credit, pick lists, the sales
  report, voids, the screen lock).
- **Release:** only after every check passes.

### When something goes wrong

Record it as an issue; deal with the immediate effect; find the cause; change
what caused it (code, test, procedure or training); check that the fix
worked; close the issue. Every bug fixed in the code gets a test, so it can't
come back unnoticed.

### Internal audit (yearly)

Someone outside the daily work checks a sample of the
[Statement of Applicability](statement-of-applicability.md) against its
evidence, the [risk register](risk-register.md) decisions, the incident
issues, and the backup and restore records. Each finding becomes an issue.

### Management review (yearly)

The owners meet to review the objectives' results, audit findings, incidents
and problems, changes in the business or the suppliers, the risks, customer
feedback, and what to improve next. Keep minutes: date, decisions, and who
does what.

### Continual improvement

Improvements come from incidents, audits, reviews and staff suggestions.
Each one becomes an issue, and the owners decide the order.

## AI (ISO/IEC 42001)

The POS has no AI features: it makes no automated predictions or decisions,
and sends no customer or staff data to any AI service. ISO/IEC 42001 doesn't
apply to the system.

AI coding assistants have been used to write parts of the code. That work is
treated like any other change: it goes through the same tests and review
before release. Never paste secrets (device keys, passwords, the database
password, the backup passphrase) or customers' details into an AI tool; if
one was shared, replace it ([policies.md](policies.md) §4).
