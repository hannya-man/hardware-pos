# Statement of Applicability

The 93 controls of ISO/IEC 27001:2022 Annex A (with ISO/IEC 27002:2022 as
their guidance), then the seven cloud controls of ISO/IEC 27017. For each:
who meets it, how, and where the evidence is.

**Who:**
**System** means the POS does it, and the code and tests show it.
**Store** means the owners and staff do it, following [policies.md](policies.md).
**Both** means a system feature plus a store routine.
**Provider** means Supabase or GitHub does it under their own certifications.

Paths are in this repository. "API" means
`supabase/migrations/20261015000001_pos_api.sql`; "tests" means `tests/`.

All 93 controls apply except where marked **Not applicable**, with the reason.

Reviewed by: ______________________  Date: ____________

## 5. Organizational controls

| Control | Who | How it's met | Evidence |
|---|---|---|---|
| 5.1 Policies for information security | Store | Information security policy and topic policies, approved by the owners and reviewed yearly | [policies.md](policies.md) §1 |
| 5.2 Information security roles and responsibilities | Store | Owners are accountable; one owner is the named security contact; staff duties listed | [policies.md](policies.md) §2 |
| 5.3 Segregation of duties | System | A void needs two different owners, and owner accounts are made (and their passwords, roles and two-factor login reset) only in Supabase, so no owner can make or take over a second owner to approve their own void; cashiers can't change prices, stock or staff; the cash count is blind (the expected amount shows only after counting) and a closed shift's count can't be changed. The server checks every record a till sends, so even a tampered till can't record a sale as already voided, change a total, take stock other than what was sold (or another item's), add to a recorded sale, mark a pick list picked up, or write the server's own audit events; a sale below the listed price goes on the Audit log | API `pos_void_*`, `pos.require_owner`, `pos_user_create`, `pos_user_update`, `pos.check_sale`, `pos.push_sale`, `pos.push_one`; tests "same owner twice", "an owner account is not added in the app", "refused: …", "a second "closed" can't rewrite the cash count" |
| 5.4 Management responsibilities | Store | Owners require staff to follow the policies and lead the reviews | [policies.md](policies.md) §1, §10 |
| 5.5 Contact with authorities | Store | Contacts kept for the National Privacy Commission, police, and the providers | [business-continuity.md](business-continuity.md#contacts) |
| 5.6 Contact with special interest groups | Store | Owners follow the Supabase and GitHub status pages and security notices | [service-management.md](service-management.md#suppliers) |
| 5.7 Threat intelligence | Both | Dependabot alerts on vulnerable packages and opens update pull requests; owners read GitHub's security alerts | `.github/dependabot.yml` |
| 5.8 Information security in project management | Both | Every change goes through the repository, with tests that include security checks; security is considered in each change | `.github/workflows/deploy-pages.yml`, [service-management.md](service-management.md#changes-and-releases) |
| 5.9 Inventory of information and other associated assets | Store | Inventory of devices, accounts, data and services, with owners and classification | [policies.md](policies.md) §3 |
| 5.10 Acceptable use of information and other associated assets | Store | Rules for using POS devices and accounts | [policies.md](policies.md) §5 |
| 5.11 Return of assets | Both | Leaving staff: account deactivated (signs them out everywhere), devices returned, keys retired | API `pos_user_update`; [policies.md](policies.md) §4 |
| 5.12 Classification of information | Store | Three levels (Public, Internal, Confidential), applied in the inventory | [policies.md](policies.md) §3 |
| 5.13 Labelling of information | Both | Backups are named by date and encrypted; printed slips carry no prices or personal data beyond the credit customer's name | `.github/workflows/backup.yml`, `ui.js` `printSlip` |
| 5.14 Information transfer | System | Everything travels over HTTPS (TLS); backups are encrypted before they're stored | `sync-worker.js`, `backup.yml` |
| 5.15 Access control | System | A device key plus a personal password; every server function checks the role; the tables can't be reached with the public key (Row Level Security on, no grants) | API `pos.require_*`; schema file; tests "anon blocked" |
| 5.16 Identity management | Both | One account per person; accounts are deactivated, never deleted, so history stays attributable; no shared accounts | Staff screen; [policies.md](policies.md) §4 |
| 5.17 Authentication information | Both | Passwords stored only as bcrypt hashes and never logged; owners use 6 digits and can add two-factor login, whose codes only the server checks (no device holds the secret) and whose wrong codes count toward the lock like wrong passwords; a password reset by someone else signs that person out everywhere; staff choose and keep passwords as the policy says | API `pos.hash_pin`, `pos.check_pin`, `pos_login`, `pos_user_update`; tests "wrong codes count toward the lock…", "the 2FA secret stays on the server…"; [policies.md](policies.md) §4 |
| 5.18 Access rights | Both | Owners add and change cashiers on the Staff screen and every change is logged; owner accounts are added, and their sign-in reset, only in Supabase, each change on the Audit log; the last owner can't be removed; accounts reviewed quarterly | Activity log `staff_*` events; Audit log `owner_account_changed`; tests "last owner stays…", "...audited" |
| 5.19 Information security in supplier relationships | Store | Suppliers listed, with what each holds and their security commitments | [service-management.md](service-management.md#suppliers) |
| 5.20 Addressing information security within supplier agreements | Store | Supabase's and GitHub's terms and data processing terms accepted and kept on file | [service-management.md](service-management.md#suppliers) |
| 5.21 Managing information security in the ICT supply chain | System | Packages locked to exact versions; a release is blocked if a shipped package has a known high-severity vulnerability; weekly update proposals | `package-lock.json` files, `deploy-pages.yml` (npm audit), `dependabot.yml` |
| 5.22 Monitoring, review and change management of supplier services | Both | Daily check that the site and database answer; owners watch providers' status pages and changelogs | `backup.yml` health job |
| 5.23 Information security for use of cloud services | Both | Shared responsibilities, data location and exit plan | [ISO/IEC 27017 section](#isoiec-27017-cloud-services) below |
| 5.24 Information security incident management planning and preparation | Store | Incident procedure: who does what | [policies.md](policies.md) §7 |
| 5.25 Assessment and decision on information security events | Both | The Audit log screen lists events that need a decision; owners review it weekly | Audit log screen; API `pos_audit_log` |
| 5.26 Response to information security incidents | Store | Step-by-step response, including the 72-hour notice for personal data breaches | [policies.md](policies.md) §7 |
| 5.27 Learning from information security incidents | Store | Each incident is recorded as a GitHub issue with its cause and fix | `.github/ISSUE_TEMPLATE/problem-report.md` |
| 5.28 Collection of evidence | System | Audit and activity logs are append-only (the database refuses edits and deletes), carry the device and address, and download as CSV | Schema triggers `append_only`; Audit log download |
| 5.29 Information security during disruption | System | Passwords, roles and lockouts keep working offline; offline records sync with the same checks later | `input-handler.js`, `sync-worker.js` |
| 5.30 ICT readiness for business continuity | Both | Offline selling, the app cached on each device, nightly backups, a tested restore | [business-continuity.md](business-continuity.md) |
| 5.31 Legal, statutory, regulatory and contractual requirements | Store | Data Privacy Act of 2012 (RA 10173). The POS is not a BIR-accredited receipt system; the store issues its registered invoices separately | [policies.md](policies.md) §8 |
| 5.32 Intellectual property rights | Store | Open-source packages used under their licences (MIT and similar), listed in the package files | `package.json` files |
| 5.33 Protection of records | System | Sales are voided, never deleted; payments and logs can't be changed; the database is backed up nightly | Schema triggers; `backup.yml` |
| 5.34 Privacy and protection of PII | Both | Only a name and phone kept for credit customers; erasure on request; breach notice process | API `pos.anonymize_customer`; [policies.md](policies.md) §8 |
| 5.35 Independent review of information security | Store | A yearly review by someone outside daily operations (an adviser), or the certification audit | [README.md](README.md#steps-left-for-the-store) |
| 5.36 Compliance with policies, rules and standards for information security | Store | Monthly checklist | [policies.md](policies.md) §10 |
| 5.37 Documented operating procedures | Store | Setup, recovery, requests and changes are written down | [DEPLOY.md](../../DEPLOY.md), [business-continuity.md](business-continuity.md), [service-management.md](service-management.md) |

## 6. People controls

| Control | Who | How it's met | Evidence |
|---|---|---|---|
| 6.1 Screening | Store | References and ID checked before anyone gets an account | [policies.md](policies.md) §4 |
| 6.2 Terms and conditions of employment | Store | Staff agree to the acceptable use rules when they start | [policies.md](policies.md) §5 |
| 6.3 Information security awareness, education and training | Store | Briefing for new staff (passwords, locking the till, reporting problems), repeated yearly | [policies.md](policies.md) §5 |
| 6.4 Disciplinary process | Store | The store's normal staff rules apply; the logs provide the facts | Activity and Audit logs |
| 6.5 Responsibilities after termination or change of employment | Both | Deactivating an account ends every server sign-in at once; done on the last day | API `pos_user_update`; tests "deactivated account signed out everywhere" |
| 6.6 Confidentiality or non-disclosure agreements | Store | Staff keep customers' details, prices and passwords confidential | [policies.md](policies.md) §5 |
| 6.7 Remote working | Both | Owner screens need a registered device and a password, and sign-ins expire; owners only use registered devices away from the store | API `pos.require_user`; [policies.md](policies.md) §5 |
| 6.8 Information security event reporting | Store | Staff tell an owner at once; the owner records it | [policies.md](policies.md) §7 |

## 7. Physical controls

| Control | Who | How it's met | Evidence |
|---|---|---|---|
| 7.1 Physical security perimeters | Store | Tills inside the store; stockroom kept locked | [policies.md](policies.md) §5 |
| 7.2 Physical entry | Store | Store and stockroom keys held by the owners | [policies.md](policies.md) §5 |
| 7.3 Securing offices, rooms and facilities | Store | As 7.1 and 7.2 | [policies.md](policies.md) §5 |
| 7.4 Physical security monitoring | Store | CCTV if installed; otherwise the till is always in staff view | [policies.md](policies.md) §5 |
| 7.5 Protecting against physical and environmental threats | Store | Devices kept off the floor and away from water, on surge protection | [policies.md](policies.md) §5 |
| 7.6 Working in secure areas | Store | Only the stockroom is a restricted area; staff enter it for their work only | [policies.md](policies.md) §5 |
| 7.7 Clear desk and clear screen | Both | A till locks itself after 10 minutes unused, and "Take a break" locks it at once; a till reopened after more than 10 minutes (closed overnight, say) asks for a password again; passwords are typed hidden; passwords and keys are never written down at the till | `main.js` idle lock and startup check; tests "idle lock…", "reopened the next day…"; [policies.md](policies.md) §5 |
| 7.8 Equipment siting and protection | Store | Till screens and keypads placed so customers can't watch passwords being typed | [policies.md](policies.md) §5 |
| 7.9 Security of assets off-premises | Store | A device leaves the store only with an owner's approval, locked | [policies.md](policies.md) §5 |
| 7.10 Storage media | Both | Backups exist only encrypted; no copies of store data on USB drives | `backup.yml`; [policies.md](policies.md) §6 |
| 7.11 Supporting utilities | Both | Selling continues through internet outages; the router and till run on a UPS or power bank where possible | [business-continuity.md](business-continuity.md) |
| 7.12 Cabling security | Store | Router and cables out of customers' reach | [policies.md](policies.md) §5 |
| 7.13 Equipment maintenance | Store | Operating system and browser updated monthly | [policies.md](policies.md) §5 |
| 7.14 Secure disposal or re-use of equipment | Store | Before a device is reused or thrown away: clear the site's data and retire its key | [policies.md](policies.md) §5 |

## 8. Technological controls

| Control | Who | How it's met | Evidence |
|---|---|---|---|
| 8.1 User endpoint devices | Both | Each device needs its own key; a device holds only what selling needs (never cost prices); devices have a screen lock and updates | API `pos_catalog`; [policies.md](policies.md) §5 |
| 8.2 Privileged access rights | Both | Owner-only screens are enforced on the server; Supabase and GitHub admin access limited to the owners, with two-factor login | API `pos.require_owner`; [policies.md](policies.md) §4 |
| 8.3 Information access restriction | System | Role checks in every function; cost prices and password hashes are never shown on any screen; tables closed to the public key | API; tests "catalog hides cost_price", "staff list" |
| 8.4 Access to source code | Both | Code on GitHub; only owners can push or approve; `main` protected so changes need the passing test check | Repository settings; [README.md](README.md#steps-left-for-the-store) |
| 8.5 Secure authentication | System | bcrypt hashes; five wrong passwords lock the account for a minute, on the server and on each till (where the count survives a page reload); optional two-factor for owners; device keys; server sign-ins end after 12 hours or 2 idle hours; sign-in tokens stored only as hashes; a sign-in prompt never appears for someone who already left | API `pos.check_pin`, `pos.require_user`, `pos_login`; `input-handler.js`, `session.js`; tests "sign-in older than 12 hours…", "the lock is saved on the device…", "no password prompt left behind…" |
| 8.6 Capacity management | Store | Supabase usage checked monthly against the plan's limits | [service-management.md](service-management.md#capacity-and-availability) |
| 8.7 Protection against malware | Both | Devices run their operating system's protection; the app's Content-Security-Policy blocks injected scripts | `vite.config.js`; [policies.md](policies.md) §5 |
| 8.8 Management of technical vulnerabilities | Both | Dependabot alerts and updates; release blocked by known high-severity issues; private vulnerability reports | `dependabot.yml`, `deploy-pages.yml`, `SECURITY.md` |
| 8.9 Configuration management | System | All configuration is versioned in git (workflows, SQL, build); secrets live only in GitHub's encrypted secrets | Repository history |
| 8.10 Information deletion | Both | Customer erasure on request; devices' data cleared when retired; retention reviewed yearly | API `pos.anonymize_customer`; [policies.md](policies.md) §8 |
| 8.11 Data masking | System | Cost prices never leave the server; password hashes and two-factor secrets are left out of every screen's data, and two-factor secrets never reach a device at all; tokens stored hashed | API `pos.user_json`, `pos_catalog` |
| 8.12 Data leakage prevention | System | The Content-Security-Policy lets the app send data only to its own Supabase project; the public key can't read tables; backups are encrypted | `vite.config.js`; schema file; `backup.yml` |
| 8.13 Information backup | Both | Encrypted nightly backups kept 30 days; a restore is tested quarterly | `backup.yml`; [business-continuity.md](business-continuity.md#restoring-a-backup) |
| 8.14 Redundancy of information processing facilities | Both | Each till keeps selling on its own; the providers run redundant hosting; a spare device is kept ready | [business-continuity.md](business-continuity.md) |
| 8.15 Logging | System | A per-shift activity log and an audit log (wrong passwords, voids, cash differences, stock problems), each with device and address; both append-only | Schema; API `pos.record_activity`, `pos.check_pin`; tests "wrong passwords recorded…" |
| 8.16 Monitoring activities | Both | Audit log screen reviewed weekly; daily health check emails the owner on failure; a record the server refuses is shown on the till ("not synced") until it goes through | Audit log screen; `backup.yml`; `sync-worker.js`; test "a refused record is announced" |
| 8.17 Clock synchronization | System | Expiry, void deadlines and reports use the server's clock; a delivery dated more than 6 hours ahead is corrected and logged; devices set to automatic time | API `pos.push_stock_batch`, `pos.present_void` |
| 8.18 Use of privileged utility programs | Store | Supabase's SQL Editor is used only by owners, only for the documented tasks | [DEPLOY.md](../../DEPLOY.md); [policies.md](policies.md) §4 |
| 8.19 Installation of software on operational systems | Store | Tills run only the browser and what they need; the POS itself installs nothing | [policies.md](policies.md) §5 |
| 8.20 Networks security | Both | HTTPS only; the store's Wi-Fi uses WPA2 or WPA3 with a strong password | [policies.md](policies.md) §5 |
| 8.21 Security of network services | Provider | Supabase and GitHub Pages serve only over TLS | [service-management.md](service-management.md#suppliers) |
| 8.22 Segregation of networks | Store | Customer or guest Wi-Fi kept separate from the tills' network | [policies.md](policies.md) §5 |
| 8.23 Web filtering | Store | Tills are used for the POS only, not for browsing | [policies.md](policies.md) §5 |
| 8.24 Use of cryptography | System | TLS in transit; bcrypt for passwords; SHA-256 for device keys and tokens; AES-256 for backups; Supabase encrypts its storage | API; `backup.yml` |
| 8.25 Secure development life cycle | System | Every change runs the tests; nothing is published unless they pass | `deploy-pages.yml` |
| 8.26 Application security requirements | System | Security requirements are written down (roles, two-owner voids, offline rules) and covered by tests | This folder; `tests/` |
| 8.27 Secure system architecture and engineering principles | System | Least privilege (functions only, no direct table access), defence in depth (RLS, no grants, role checks), works offline | Schema and API files |
| 8.28 Secure coding | System | Every screen escapes what it shows; input from tills is validated on the server; SQL runs in fixed functions with a pinned search path, never pieced together from input; no `eval`; Content-Security-Policy; downloads can't carry spreadsheet formulas | `ui.js` `esc`; API; `vite.config.js`; `admin.js` `csvCell` |
| 8.29 Security testing in development and acceptance | System | The tests check access control (public key blocked, roles, lockouts, expiry, the two-owner rule, tampered records) and use the app in a simulated browser on every change | `tests/sql.test.mjs`, `tests/ui.test.mjs` |
| 8.30 Outsourced development | Store | Code from outside help, including AI coding assistants, goes through the same tests and review | [service-management.md](service-management.md#ai-isoiec-42001) |
| 8.31 Separation of development, test and production environments | Both | Tests run on a throwaway database; larger changes are tried on a second Supabase project first | `tests/harness.mjs`; [service-management.md](service-management.md#changes-and-releases) |
| 8.32 Change management | Both | Changes are tracked in git, tested before release, and database changes go in dated migration files | `deploy-pages.yml`; `supabase/migrations/` |
| 8.33 Test information | System | Tests use made-up data only, never a copy of the live database | `tests/` |
| 8.34 Protection of information systems during audit testing | Store | Auditors get exports (the Audit log download, reports), not owner accounts | [policies.md](policies.md) §10 |

## ISO/IEC 27017: cloud services

### Who is responsible for what

| Area | Supabase (database) | GitHub (code and site) | The store |
|---|---|---|---|
| Data centres, servers, networks | Yes | Yes | No |
| Encrypting stored data | Yes | Yes (code) | Backups (`backup.yml`) |
| Database software patching | Yes | n/a | No |
| Who can sign in to the POS, and what they can do | No | No | Yes (the POS's own controls) |
| Admin accounts on Supabase and GitHub | Provides two-factor login | Provides two-factor login | Turns it on and limits who has access |
| Backups of POS data | Not on the free plan | n/a | Yes (nightly, encrypted) |
| Keys and secrets | Issues them | Stores Actions secrets | Keeps them out of the code and rotates them if exposed |
| Availability | Runs the service | Runs Pages | Offline selling, health check, recovery plan |

### Cloud controls

| Control | Who | How it's met |
|---|---|---|
| CLD.6.3.1 Shared roles and responsibilities within a cloud computing environment | Store | The table above |
| CLD.8.1.5 Removal of cloud service customer assets | Store | Exit plan: take a final backup, check that it restores, then delete the Supabase project and turn off Pages ([business-continuity.md](business-continuity.md#leaving-a-provider)) |
| CLD.9.5.1 Segregation in virtual computing environments | Provider | Supabase keeps each project in its own database; the store uses separate projects for live and test |
| CLD.9.5.2 Virtual machine hardening | **Not applicable** | The store runs no virtual machines; Supabase and GitHub manage their servers |
| CLD.12.1.5 Administrator's operational security | Store | Admin tasks are documented ([DEPLOY.md](../../DEPLOY.md)), done only by owners with two-factor login |
| CLD.12.4.5 Monitoring of cloud services | Both | Daily health check; Supabase's usage and logs pages checked monthly |
| CLD.13.1.4 Alignment of security management for virtual and physical networks | **Not applicable** | The store manages no virtual networks |

**Where the data is:** the database is in Supabase's Southeast Asia
(Singapore) region. GitHub Pages serves only the app's code, which holds no
store data. The nightly backups are stored by GitHub Actions, encrypted.
