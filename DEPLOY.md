# Putting the POS online: GitHub Pages + Supabase

- **The app** (`caidic-pos-frontend`) is a static site. GitHub Actions builds it
  and GitHub Pages serves it, at `https://hannya-man.github.io/hardware-pos/`.
- **Supabase** holds the database and the server logic. The SQL in `supabase/`
  replaces the Laravel API: the same checks, as Postgres functions the app
  calls directly. `caidic-pos-laravel-fresh` is no longer used by the app.

Set it up once, in this order.

## 1. Supabase

1. At [supabase.com](https://supabase.com), create a project. Pick the
   **Southeast Asia (Singapore)** region, the closest to the store, and keep
   the database password somewhere safe. The other options can stay as they
   are: the SQL sets its own permissions.
2. Open **SQL Editor**. For each file below, paste its contents into a new
   query and click **Run**, in this order:
   1. `supabase/migrations/20261015000000_pos_schema.sql`: the tables
   2. `supabase/migrations/20261015000001_pos_api.sql`: the server functions
   3. `supabase/migrations/20261016000000_security_controls.sql`: audit log
      additions
   4. `supabase/migrations/20261017000000_security_fixes.sql`: security fixes
   5. `supabase/seed.sql`: the 12 categories and 194 items
   6. `supabase/starting-stock.sql` (optional): 100 of each item in the store,
      like the local test setup. Skip it if you'll enter real counts on the
      Stock screen.
3. Still in the SQL Editor, add the owners and register the first device:

   ```sql
   select pos.add_staff('Rosa Cruz', 'owner', '123456');   -- owners use 6 digits
   select pos.add_staff('Carlo Cruz', 'owner', '654321');  -- voids need two owners
   select pos.add_terminal('Front counter');
   ```

   `pos.add_terminal` shows the device's key **once**. Copy it for step 4.
   Cashiers can be added later from the Staff screen; owner accounts only
   here (see [Owner accounts](#owner-accounts)).
4. Click **Connect** at the top of the project and copy the **Project URL**
   and the **publishable key** (`sb_publishable_...`). Every key is also listed
   under **Settings > API Keys**; on an older project the legacy `anon` key
   works the same way.

## 2. GitHub

In the repository on github.com:

1. **Settings > Secrets and variables > Actions > New repository secret**,
   twice:
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_PUBLISHABLE_KEY`: the publishable key
2. **Settings > Pages > Build and deployment > Source**: choose
   **GitHub Actions**.
3. **Backups.** Supabase's free plan keeps no backups, so the **Nightly
   backup** workflow makes them, encrypted. Add two more secrets:
   - `SUPABASE_DB_URL`: in Supabase, **Connect → Session pooler** (not
     Direct connection: GitHub can't reach that one). Copy the connection
     string and replace `[YOUR-PASSWORD]`, brackets included, with the
     database password. (Forgot the password, or it has symbols like
     `# / ? %` in it? Reset it under **Settings > Database** to one made of
     letters and numbers.)
   - `BACKUP_PASSPHRASE`: a long random passphrase, for example five or six
     random words. Keep it in a password manager **and** sealed in the store's
     safe: without it the backups can't be opened.

   Then open **Actions → Nightly backup → Run workflow** once to check that
   it works. After that it runs by itself every night at about 02:15
   (GitHub sometimes starts it later). If a run fails, its page says why.

   `SUPABASE_DB_URL` also lets the **Update the database** workflow bring the
   database up to date by itself (see [Good to know](#good-to-know)).
4. **Protection** (needs the repository owner's account):
   - **Settings > Branches**: add a rule for `main` that requires the **test**
     check to pass before merging.
   - **Settings**, security section (**Code security**, or **Advanced
     Security** on newer accounts): turn on **Dependabot alerts** and
     **Private vulnerability reporting**.

## 3. Publish

Commit and push to `main`. The **Deploy to GitHub Pages** workflow (Actions
tab) runs the tests, builds the app and publishes it in a few minutes. Every
later push to `main` publishes again, but only if the tests pass; **Run
workflow** on the Actions tab does it by hand.

## 4. Each device

Open the site. The first time, it asks for a terminal key: enter the one from
`pos.add_terminal`. The device then downloads the staff list and the items, and
people can sign in. Every device (or browser) needs its own key:

```sql
select pos.add_terminal('Stockroom tablet');
```

To retire a device, open **Table Editor > terminals** and set its
`is_active` to `false`.

To give a device a new key (say its key was seen by someone it shouldn't
have been), make one with `pos.add_terminal`, then retire the old key as
above. Within a few minutes the device asks for the new key (or straight away
on **Sync now**); type it in. Nothing it made meanwhile is lost: sales stay on
the device and go up once the new key is in.

## Owner accounts

Owner accounts are added, and their sign-in reset, only in the SQL Editor.
In the app, one owner could otherwise make a second owner account (or take
over the other owner's) and approve their own voids, which need two owners.
Each of these is on the owners' **Audit log**:

```sql
select pos.add_staff('Maria Santos', 'owner', '123456');      -- a new owner
select pos.reset_password('<staff id>', '654321');            -- a forgotten password
select pos.set_role('<staff id>', 'owner', '123456');         -- make an owner (or 'cashier', with '1234')
select pos.turn_off_two_factor('<staff id>');                 -- an owner lost the phone with their authenticator app
```

The staff id is in **Table Editor > users**. In the app, an owner adds and
edits cashiers, and changes their own password and two-factor login. Two-factor
codes are checked by the server, so a device never holds the secret.

## Running it on this computer

Copy `caidic-pos-frontend/.env.example` to `caidic-pos-frontend/.env.local`,
fill in the same two values, then run `npm run dev` in the project folder. It
uses the same Supabase project as the published site.

## Good to know

- **Offline.** Sales, shifts and payments are saved on the device and sync
  when the internet is back, as before. Once a device has opened the site, it
  keeps a copy of the app, so it also opens with the internet down.
- **Security.** The publishable key ships inside the app and is meant to be
  public. With it, the tables can't be read or written (Row Level Security is
  on and the public roles have no grants); only the `pos_*` functions can be
  called, and they check the terminal key or the person's password, the way
  the Laravel API did. Never put the `service_role` or secret key in the app.
- **Free plan pause.** Supabase pauses a free project after a week with no
  activity. A store that opens daily won't hit this; if it happens, restore the
  project from the Supabase dashboard.
- **Changing the server logic.** Edit
  `supabase/migrations/20261015000001_pos_api.sql`; every function in it is
  replaced in place. Table changes go in a new, dated file in
  `supabase/migrations`, written so it can run more than once. Run `npm test`
  in `tests/` first; the checks run on a throwaway database, never the live
  one.
- **Bringing the database up to date.** A push to `main` that changes
  `supabase/migrations` starts the **Update the database** workflow: it runs
  the server tests, then the API file and the dated files after
  `20261016000000_security_controls.sql`, in one transaction (all of it or
  nothing). **Run workflow** on it does the same by hand. Without the
  `SUPABASE_DB_URL` secret, run the same files in the SQL Editor instead, in
  that order.
- **The store's time zone** for "today" and "this week" is set in
  `pos.store_timezone()` (Asia/Manila).
- **ISO standards.** What the system does for ISO/IEC 27001, 27017, 22301,
  20000-1 and ISO 9001, and what's left for the store, is in
  [docs/compliance](docs/compliance/README.md).
