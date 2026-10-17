# Risk register

The main risks to the POS and the store's data, what already reduces each
one, and the decision on what's left. ISO/IEC 27001 (clauses 6.1 and 8.2,
8.3) asks the owners to make these decisions and review them at least once a
year, or after any incident or big change.

Likelihood and impact: **Low**, **Medium** or **High**. "Left" is the risk
after the controls in place.

Accepted by: ______________________  Date: ____________  Next review: ____________

| # | Risk | Likelihood | Impact | What's in place | Left | Decision and owner action |
|---|---|---|---|---|---|---|
| 1 | A POS device is lost or stolen. It holds the staff's password hashes (needed to sign in offline), owners' two-factor secrets, recent sales and credit customers' names | Low | High | The device is useless without a staff password; its key can be retired at once, which stops it syncing and signing in to the server; hashes are bcrypt (slow to crack) | Medium: short passwords can be cracked from a stolen device given time | **Accept** with the response in [policies.md](policies.md) §7: retire the device key, then change every staff password and redo two-factor setup. Turn on the device's own screen lock and disk encryption |
| 2 | A cashier's 4-digit password is guessed or seen | Medium | Medium | Five wrong tries lock the account for a minute; every wrong try is on the Audit log; each person's actions are logged; owners use 6 digits and two-factor login | Low | **Accept.** Place keypads out of customers' view. Moving cashiers to 6 digits is an option if the Audit log shows guessing |
| 3 | A device key leaks | Low | Medium | Shown once, stored only as a hash; useless without a staff password to sign in; retiring the key blocks it | Low | **Accept.** Never write keys down at the till |
| 4 | Someone takes over an owner's Supabase or GitHub account | Low | High | Secrets are kept in GitHub's encrypted secrets, not in the code; the `main` branch is protected | Medium until two-factor login is on for those accounts, then Low | **Reduce:** turn on two-factor login for every account that can change the POS (README step 1) |
| 5 | The store's internet is down | High | Low | Selling, credit, pick lists and shifts work offline and sync later; the app opens offline once loaded | Low | **Accept** |
| 6 | Supabase is down, or the free project is paused after a week without use | Low | Medium | Selling continues offline; the daily health check emails the owner; a paused project is restored from the dashboard with its data | Low | **Accept.** Restore a paused project the same day |
| 7 | Data is lost or damaged: a mistake, corruption, or losing the project | Low | High | Sales, payments and logs can't be edited or deleted through the app; nightly encrypted backups kept 30 days; a written restore procedure | Low to Medium: up to a day of server data could be lost (recent sales are still on the tills) | **Accept,** and test a restore every quarter. If a day's loss is too much, Supabase's paid plan adds daily backups and point-in-time recovery |
| 8 | The backup passphrase is lost | Low | High | Kept in two places outside GitHub | Low | **Reduce:** a password manager plus a sealed copy in the store's safe |
| 9 | Staff fraud: unauthorized voids, cash taken, false returns | Medium | Medium | A void needs two owners; end-of-shift counts are blind; returns need an owner and proof; every action is on the shift's timeline; differences show on the Audit log | Low | **Accept.** Owners review cash differences and voids weekly |
| 10 | Personal data leaks (credit customers' names and phones, staff names) | Low | Medium | Only the minimum is kept; access is limited by role; tables are closed to the public key; backups are encrypted; erasure on request | Low | **Accept.** Breach steps and the 72-hour notice in [policies.md](policies.md) §7 |
| 11 | A bad or malicious change reaches the live app, including through a package | Low | High | Tests gate every release; packages with known high-severity issues block it; Dependabot updates; owners approve changes to `main` | Low | **Accept.** Protect `main` (README step 3) |
| 12 | Malicious script runs in the app (XSS) | Low | High | Everything shown is escaped; the Content-Security-Policy runs only the app's own code; no third-party scripts | Low | **Accept** |
| 13 | Two offline tills sell the same last items, so stock goes wrong | Medium | Low | Each sale is recorded against the oldest stock; overselling is flagged on the Audit log for an owner to fix the count | Low | **Accept** (the price of selling offline) |
| 14 | A device's clock is wrong | Medium | Low | Deadlines, expiry and reports use the server's clock; a delivery dated in the future is corrected and logged | Low | **Accept.** Set devices to automatic time |
| 15 | A till is left signed in and someone else uses it | Medium | Medium | It locks itself after 10 minutes unused; "Take a break" locks it at once; everything done is logged under that person | Low | **Accept** |
| 16 | GitHub Pages is down, or the repository is lost | Low | Medium | Devices keep their copy of the app; the code is also on the owners' computers; the app can be published on any static host | Low | **Accept** |
| 17 | The free plan's limits are reached (database size, traffic) | Low | Medium | Usage checked monthly | Low | **Accept.** Upgrade before the limit |
| 18 | Nightly backups stop without anyone noticing (GitHub turns off scheduled workflows in a repository with no activity for 60 days) | Medium | High | GitHub emails the owner when a run fails; the monthly check confirms the latest backup exists | Low to Medium | **Reduce:** check the latest backup monthly ([policies.md](policies.md) §10); re-enable the workflow if GitHub turned it off |
| 19 | One owner voids a sale alone, through a second owner account they made or took over | Low | High | Owner accounts are made, and their passwords, roles and two-factor login reset, only in Supabase; each such change is on the Audit log; the void shows both approvers | Low | **Accept.** Keep Supabase access to the owners, with two-factor login; review owner-account changes on the Audit log weekly |
| 20 | A device key is seen by someone it shouldn't be (pasted in a chat, say), who downloads the password hashes or sends made-up records | Low | High | Keys are replaced without losing data (the device asks for the new one); the server checks every record a till sends; two-factor secrets never leave the server | Low once replaced | **Reduce:** replace a key the moment it may have been seen ([DEPLOY.md](../../DEPLOY.md#4-each-device)) |
