# Business continuity plan

How the store keeps selling when something fails, and how it gets back to
normal. Written for ISO 22301; tested by the exercises at the end.

Approved by: ______________________  Date: ____________

## What matters most

| Activity | Longest the store can be without it | Recovery target | Most data that may be lost |
|---|---|---|---|
| Selling at the counter (cash, GCash / PayMaya, credit) | 15 minutes | Works offline; a spare device within 15 minutes | None: each sale stays on its device until it syncs |
| Taking credit payments | 1 day | Works offline | None, as above |
| Pick lists to the stockroom | 1 hour | Works offline on the same device; between devices once online | None |
| Owner screens (dashboard, stock, sales, staff, Audit log) | 2 days | 4 hours | Up to 24 hours (since the last nightly backup) |
| The central database | 1 day | 4 hours | Up to 24 hours |

## When something fails

| What fails | What still works | What to do | Getting back to normal |
|---|---|---|---|
| The store's internet | Selling, credit, pick lists on the same device, shifts. The status shows **Offline** | Keep selling | Automatic: everything syncs when the internet is back |
| Supabase | Same as above | Keep selling; check status.supabase.com | Automatic |
| Supabase paused the project (free plan, after a week without use) | Same as above | An owner clicks **Restore** on the project in the Supabase dashboard | Data is kept while paused |
| GitHub Pages | Every device that has opened the app before | Don't clear the browser's data | Automatic |
| A till breaks | Other devices | Open the site on a spare device or a phone and enter a device key (make one with `pos.add_terminal` if needed) | Sales not yet synced stay on the broken device; connect it again if it can be turned on |
| A till is lost or stolen | Other devices | Incident steps in [policies.md](policies.md) §7 | Retire its key; change staff passwords |
| Power cut | Devices on battery or a UPS | Keep selling on battery; keep the router powered if possible | Automatic |
| Data deleted or damaged | Tills keep selling from their own copy | An owner stops any changes and restores the latest backup into a new project | [Restoring a backup](#restoring-a-backup) |
| An owner is unavailable | The other owner | Two owners hold admin access; the backup passphrase is also in the store's safe | |
| An admin account is taken over | Selling | Incident steps in [policies.md](policies.md) §7 | |

## Restoring a backup

Use this for the quarterly test (into a spare project) and for a real
recovery (into a new project). Always restore into an **empty** project,
never over the live one.

**You need:** the backup passphrase; an empty Supabase project (for a test,
create a second free project); **Git Bash**, which comes with Git for Windows
and includes `gpg` and `tar`; and **psql**, which comes with PostgreSQL
(for example `C:\Program Files\PostgreSQL\<version>\bin\psql.exe`).

1. **Download.** On GitHub, open **Actions → Nightly backup**, pick a run,
   and download its artifact. Unzip it to get
   `pos-backup-YYYY-MM-DD.tar.gz.gpg`.
2. **Decrypt.** In Git Bash, in that folder (it asks for the passphrase):

   ```sh
   gpg --decrypt pos-backup-YYYY-MM-DD.tar.gz.gpg > pos-backup.tar.gz
   mkdir pos-backup && tar -xzf pos-backup.tar.gz -C pos-backup
   ```

3. **Restore.** Copy the empty project's connection string from **Connect →
   Session pooler**, with its database password filled in:

   ```sh
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file pos-backup/roles.sql \
     --file pos-backup/schema.sql \
     --command 'SET session_replication_role = replica' \
     --file pos-backup/data.sql \
     --dbname "<connection string>"
   ```

4. **Check.** In the restored project's **Table Editor**, the products,
   sales and staff are there. For a test, compare
   `select count(*) from public.sales;` with the live project.
5. **For a test:** write the result in the [exercise record](#exercise-record),
   delete the decrypted files, and delete the test project if it's no longer
   needed.
6. **For a real recovery:** point the app at the restored project. Change the
   `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` secrets to the new project's
   values and run **Actions → Deploy to GitHub Pages**; change
   `SUPABASE_DB_URL` too, so backups continue. Devices keep working with
   their existing keys, which were restored with everything else. Sales that
   synced after the backup was taken are not in it: check the last day's
   sales against the tills and the paper slips.

## Leaving a provider

1. Run **Actions → Nightly backup → Run workflow** for a final backup, and
   restore it somewhere to check it (above).
2. The app is plain files (`caidic-pos-frontend`, built with `npm run
   build`) and can be published on any static web host.
3. The database is standard PostgreSQL. It can be restored to any
   PostgreSQL 15 or newer with the `pgcrypto` extension in an `extensions`
   schema; the app needs a PostgREST-compatible API in front of it, which a
   self-hosted Supabase provides.
4. Then delete the Supabase project, which removes the data under
   Supabase's terms, and turn off GitHub Pages.

## Exercises

| How often | Exercise | It passes if |
|---|---|---|
| Every quarter | Restore the latest backup into a spare project | The restore completes and the sales count matches |
| Every year | Offline drill: during a quiet hour, turn off the store's Wi-Fi for 15 minutes and keep selling | Afterwards, every sale from those 15 minutes is on the Sales screen |
| Every year | Spare device: set up a spare device with a new key | It's ready to sell within 15 minutes |

### Exercise record

| Date | Exercise | Result | What needs fixing |
|---|---|---|---|
| | | | |

## Contacts

| Who | How to reach them |
|---|---|
| Security contact (owner) | |
| Second owner | |
| Internet provider | |
| National Privacy Commission (personal data breaches) | privacy.gov.ph |
| Police (theft) | 911 |
| Supabase status | status.supabase.com |
| GitHub status | www.githubstatus.com |
