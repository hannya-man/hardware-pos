# ISO standards: where the POS stands

## What gets certified

ISO certificates are issued to an **organization**, here RRC Merchandise,
after an accredited certification body audits how it works: its policies,
its risk decisions, its records, and whether people follow them. Software is
never certified on its own.

So this folder does two things:

1. Shows which controls the **system already has built in**, with the code
   and tests that prove it.
2. Gives the store the **documents and routines** the standards expect, ready
   to adopt, plus the steps that are left for the owners.

**Scope:** the RRC Merchandise POS. That covers the web app (published on
GitHub Pages), its database and server functions (Supabase), the devices it
runs on in the store, and the people who use and run it.

## Standard by standard

| Standard | What it asks for | Built into the system | The store's part | Document |
|---|---|---|---|---|
| **ISO/IEC 27001** (security management) | A risk-based security programme, with the Annex A controls applied where they fit | Covers 50 of the 93 Annex A controls (21 entirely, 29 together with a store routine): device keys, per-person passwords, two-factor login for owners, sign-in expiry, lockouts, role checks on the server, two-owner voids, append-only logs, an Audit log screen, encryption, nightly backups, automatic screen lock | Adopt the policies, own the risk register, train staff, review the Audit log, run an internal audit and a management review | [Statement of Applicability](statement-of-applicability.md), [risk register](risk-register.md), [policies](policies.md) |
| **ISO/IEC 27002** (control guidance) | Practical guidance for each Annex A control | Same controls as above; 27002 is the guidance they follow | Same | [Statement of Applicability](statement-of-applicability.md) |
| **ISO/IEC 27017** (cloud security) | Clear split of security duties with cloud providers, plus cloud-specific controls | Only the POS functions are reachable with the public key; data is encrypted when backed up; daily health check | Two-factor login on the Supabase and GitHub accounts; keep the providers' security reports; follow the exit plan if leaving | [Statement of Applicability, cloud section](statement-of-applicability.md#isoiec-27017-cloud-services) |
| **ISO 22301** (business continuity) | Know what's critical, how long it can stop, and prove recovery works | Selling works offline; the app opens offline; sales sync later; nightly backups | Keep a spare device; test a restore every quarter; run a yearly drill | [Business continuity plan](business-continuity.md) |
| **ISO/IEC 20000-1** (IT service management) | Defined service, requests, incidents, changes, releases, suppliers | Every change is tested before it's published; releases are automatic and recorded; health checks | Handle requests and incidents the documented way; record them as GitHub issues | [Service and quality management](service-management.md) |
| **ISO 9001** (quality management) | Quality objectives, controlled processes, fixing what goes wrong, continual improvement | 480+ automated checks run on every change, including the app used end to end in a simulated browser; a release is blocked if any fails | Track problems and fixes; yearly internal audit and management review | [Service and quality management](service-management.md#quality-management-iso-9001) |
| **ISO/IEC 42001** (AI management) | Governance of AI systems an organization builds or uses | Not applicable: the POS has no AI features | Covered by the normal change process: code written with AI help is tested and reviewed like any other change | [Service and quality management](service-management.md#ai-isoiec-42001) |

## What the system does, at a glance

- **Who can do what.** Each device needs its own key, and a key can be
  replaced without losing what the device holds. Each person has their own
  password: 4 digits for cashiers, 6 for owners, with optional two-factor
  login whose codes only the server checks (no device holds the secret).
  Every server function checks the role. The database tables can't be
  reached with the key the app ships with, and cost prices never leave the
  server.
- **Money controls.** A void needs two different owners within 10 minutes,
  and owner accounts are made, and their sign-in reset, only in Supabase, so
  no owner can make or take over a second owner to approve their own void.
  End-of-shift cash counts are blind: the expected amount shows only after
  the count, and a closed shift's count can't be changed afterwards. Sales,
  payments and logs can't be edited or deleted.
- **Records.** Each shift has a timeline of everything done in it. The Audit
  log screen lists what needs an owner's eyes: wrong passwords, cash
  differences, voids, overselling, returns, and wrong device clocks. Both can
  be downloaded.
- **Sign-ins.** Five wrong passwords lock an account for a minute, and
  reloading the page doesn't reset the count. Server sign-ins end after 12
  hours, or after 2 hours unused. A deactivated account is signed out
  everywhere at once. A till left alone locks itself after 10 minutes, and one
  reopened later (the next morning, say) asks for a password again.
- **Checks on what tills send.** The server refuses a sale that arrives
  already voided, a total that isn't what its lines add up to, stock taken
  that isn't what was sold (or is another item's), a change to a sale already
  recorded, or audit events only the server may write. A sale below the
  listed price, or dated days ahead, is kept but put on the Audit log. A
  record it refuses shows on the till as "not synced" until it's sorted out.
- **Protection in the browser.** A Content-Security-Policy stops the app from
  running anything but its own code or talking to anything but its own
  database. It refuses to run inside another site's frame.
- **Continuity.** Selling works with the internet down, and the app itself
  opens offline once a device has loaded it. The database is backed up every
  night, encrypted.
- **Change control.** Every change runs the full test suite; nothing is
  published unless it passes. Packages with known high-severity
  vulnerabilities block a release, and Dependabot proposes updates weekly.

## Steps left for the store

In rough order. Items marked **(once)** are one-time setup.

1. **(once)** Turn on two-factor login for every GitHub and Supabase account
   that can change the POS.
2. **(once)** Add the backup secrets (`SUPABASE_DB_URL`, `BACKUP_PASSPHRASE`)
   as described in [DEPLOY.md](../../DEPLOY.md), run the **Nightly backup**
   workflow once by hand, and keep the passphrase somewhere safe outside
   GitHub.
3. **(once)** In the repository settings, turn on **Private vulnerability
   reporting** and **Dependabot alerts**, and protect the `main` branch
   (require the test check to pass before merging).
4. **(once)** Read and adopt the [policies](policies.md): the owners sign and
   date them, and staff are briefed.
5. **(once)** Go through the [risk register](risk-register.md) and accept or
   change each decision.
6. **Weekly:** review the Audit log.
7. **Quarterly:** restore a backup into a spare Supabase project
   ([business continuity plan](business-continuity.md#restoring-a-backup)),
   and review who has accounts.
8. **Yearly:** an offline drill, an internal audit against these documents,
   and a management review. Then, if the store wants the certificate, book a
   certification body for the Stage 1 and Stage 2 audits.
