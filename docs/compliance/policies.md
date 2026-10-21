# Information security policies

The rules for everyone who uses or runs the RRC Merchandise POS. ISO/IEC
27001 asks for them to be approved by the owners, shared with staff, and
reviewed every year.

Approved by (owners): ______________________ / ______________________  Date: ____________

## 1. Information security policy

**Purpose.** Keep the store's information correct, available when it's
needed, and seen only by the people who should see it: sales, money, stock,
staff and customers' details.

**Scope.** The POS app, its Supabase database, the GitHub repository and
site, the devices it runs on, and everyone who uses them.

**Commitments.** The owners will:

- give each person only the access their work needs;
- follow the Data Privacy Act of 2012 (RA 10173) for customers' and staff's
  personal data;
- keep the store able to sell when the internet or a provider fails;
- record and learn from every incident;
- review these policies, the [risk register](risk-register.md) and the
  [Statement of Applicability](statement-of-applicability.md) every year.

**Objectives** (checked at the yearly review):

- every account that can change the POS (Supabase, GitHub) has two-factor login;
- a backup restore passes every quarter;
- nothing on the Audit log stays unexplained for more than a week;
- every release passes the full test suite (this is enforced automatically).

## 2. Roles

| Role | Responsibilities |
|---|---|
| Owners | Accountable for security. Approve and remove access. Review the Audit log weekly. Handle incidents. Keep the backup passphrase and admin accounts safe |
| Security contact (one named owner): ____________ | First person told about any problem; keeps the incident records; leads the yearly review |
| Cashiers and stockroom staff | Follow §4 and §5; report problems at once (§7) |
| Whoever changes the code | Makes changes through the repository; keeps the tests passing; never puts secrets or personal data in the code or in issues |

## 3. Assets and how sensitive they are

**Public:** anyone may see it. **Internal:** store staff only.
**Confidential:** only the people who need it.

| Asset | What it holds | Class | Kept by |
|---|---|---|---|
| POS devices (tills, tablets) | An offline copy of items, prices, staff password hashes, recent sales, credit customers | Confidential | Owners |
| Supabase project | All the store's data | Confidential | Owners |
| GitHub repository | The app's code (public), Actions secrets and encrypted backups (not public) | Code: Public. Secrets, backups: Confidential | Owners |
| The published site | The app's code only, no store data | Public | Owners |
| Owners' Supabase and GitHub accounts | Admin access to everything above | Confidential | Each owner |
| Device keys, the database password, the backup passphrase | Credentials | Confidential | Owners (password manager) |
| Staff passwords | Credentials | Confidential | Each person |
| Audit log and shift downloads | Names, actions, addresses | Confidential | Owners |
| Sales report downloads | Sales figures, best sellers, sales by staff | Confidential | Owners |
| Pick slips, stock-out slips | Items and quantities | Internal | Staff |
| Price list | Selling prices | Public | Staff |

## 4. Accounts and passwords

- Everyone has their own account. Never share one, and never use someone
  else's.
- An owner creates an account only after checking the person's ID and
  references, and deactivates it on their last day. Accounts are never
  deleted, so their history stays.
- Cashiers use 4 digits, owners 6. Don't use birthdays, repeated digits or
  sequences (1111, 1234, 123456). Change a password when someone else may
  have seen it. Owners turn on two-factor login in Staff.
- Never write passwords or device keys at the till, and never put them in
  chats, email or GitHub issues.
- Only owners have Supabase and GitHub accounts for the POS, each their own,
  with two-factor login on. The Supabase SQL Editor is used only for the tasks
  in [DEPLOY.md](../../DEPLOY.md); note what was done in a GitHub issue.
- Every quarter, the owners review who has access: the Staff screen (with
  "Show deactivated"), the GitHub repository's collaborators, and the
  Supabase project's members. Anything not needed is removed.
- If a secret may have been exposed, replace it: reset the database password
  in Supabase and update `SUPABASE_DB_URL`; for a device key, retire it
  (§5) and make a new one with `pos.add_terminal`.

## 5. Using POS devices

- POS devices are for the POS only: no other browsing, no personal apps.
- Keep the operating system and browser updated every month, with automatic
  time, a screen lock, the system's malware protection, and disk encryption
  where the device supports it.
- Tap **Sign out → Take a break** when leaving the till. It also locks itself
  after 10 minutes without use.
- Place screens and keypads so customers can't watch a password being typed.
- Tills stay inside the store and the stockroom stays locked; the owners hold
  the keys. Keep devices off the floor and away from water, on surge
  protection, and the router out of customers' reach.
- A device leaves the store only with an owner's approval.
- The store's Wi-Fi uses WPA2 or WPA3 with a strong password. Customers get a
  separate guest network, never the tills' network.
- Before a device is reused or thrown away, clear the site's data in the
  browser and retire its key: **Table Editor → terminals →** set `is_active`
  to `false`.
- Staff keep customers' details, cost prices and passwords confidential, both
  while they work here and after.
- New staff are briefed on §4, §5 and §7 before they get an account, and
  everyone again each year.

## 6. Backups

- The database is backed up every night at about 02:15, encrypted with
  AES-256, and kept for 30 days (GitHub **Actions → Nightly backup**).
- The passphrase is kept in a password manager and as a sealed copy in the
  store's safe. Without it, the backups can't be opened.
- Never keep unencrypted copies on shared drives or USB sticks. Delete
  decrypted copies after a restore test.
- Monthly: check that the latest backup exists. Quarterly: test a restore
  ([business-continuity.md](business-continuity.md#restoring-a-backup)).

## 7. Incidents

**Report it to an owner at once** if any of these happens: a device is lost or
stolen; someone used another person's account; there's a void or cash
difference nobody can explain; the Audit log shows many wrong passwords; a
password, device key or other secret may have leaked; the app does something
unexpected; data is missing; or personal data was seen by someone who
shouldn't see it.

The owner then:

1. **Keeps the evidence.** Download the Audit log and the shift's timeline
   before changing anything.
2. **Contains it.** Lost device: retire its key, then change the staff
   passwords that were on it and redo two-factor setup. Leaked password:
   change it. Leaked key or secret: replace it (§4). Admin account at risk:
   change its password, check two-factor login, and look at the account's
   recent activity on GitHub and Supabase.
3. **Records it** as a GitHub issue with the **Problem or incident** template.
   The repository is public, so leave out secrets and personal data; keep those
   details in a private record.
4. **Decides on notice, if personal data was involved.** If customers' or
   staff's personal data may have been exposed, the owners decide within 72
   hours of learning of it whether to notify the National Privacy Commission
   and the people affected, and write down the decision either way.
5. **Fixes and follows up.** Record the cause, the fix, and what will stop it
   happening again, then close the issue.

## 8. Personal data

- **What is kept:** credit customers' names and phone numbers, and what they
  bought on credit and paid; staff names; the network address of each logged
  action.
- **Why:** to keep track of credit (utang) and payments, and to know who did
  what.
- **Who can see it:** everyone signed in sees credit customers, because
  cashiers take their payments. Only owners see the logs.
- **How long:** a credit customer's details are kept while they have a balance
  or buy on credit. Once they owe nothing they can ask for them to be removed:
  an owner runs `select pos.anonymize_customer('<customer id>');` in the
  Supabase SQL Editor (the id is in **Table Editor → customers**). Their
  sales and payments stay as the store's financial records, under "Removed
  customer". Sales records are kept as long as the store's accountant says
  the tax rules require.
- **Requests:** a customer may ask to see, correct or remove their details.
  Correct them on the Credit screen (**Edit**); remove them as above.
- **Notice at the counter** (suggested wording): *"For credit purchases we
  keep your name and phone number to track what you owe and what you've paid.
  Ask us any time to see or correct them, or to remove them once your balance
  is paid."*

## 9. Suppliers and cloud services

| Supplier | What it does for the POS | Where |
|---|---|---|
| Supabase | Database and server functions | Southeast Asia (Singapore) region |
| GitHub | Code, automatic tests and releases, the published site (Pages), backup storage | Global |

Keep a dated copy of each one's terms, data processing terms, and current
security reports. Review them every year: are they still suitable, have they
had incidents, have their terms changed? Who is responsible for what is in
the [Statement of Applicability](statement-of-applicability.md#isoiec-27017-cloud-services);
the exit plan is in [business-continuity.md](business-continuity.md#leaving-a-provider).

## 10. Checks and reviews

| When | What | Who |
|---|---|---|
| Weekly | Review the Audit log; open an incident for anything unexplained | Owners |
| Monthly | Latest backup exists; no failed runs under **Actions**; Supabase usage within the plan's limits; device updates done; Dependabot pull requests handled | Security contact |
| Quarterly | Restore test; access review (§4) | Owners |
| Yearly | Review these policies and the risk register; staff refresher; offline drill; internal audit (check each row of the Statement of Applicability against its evidence); management review | Owners |

Auditors get exports (Audit log and shift downloads, this folder), never an
owner's account.
