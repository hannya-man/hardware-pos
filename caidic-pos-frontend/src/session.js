// session.js — who is signed in on this terminal and which shift they're on,
// plus their connection to the server for screens that read it.

import { requestToken, saveServerLogin, logActivity, setActiveShift } from './sync-worker.js';
import { showPrompt } from './ui.js';

export const session = { user: null, shiftId: null };

// The password typed at sign-in, kept in memory only (never saved), so the
// server login can happen on its own instead of asking for it a second time.
let password = null;

export function setSession(user, shiftId, typedPassword = null) {
  session.user = user;
  session.shiftId = shiftId;
  password = user ? typedPassword ?? password : null;
  setActiveShift(shiftId);
}

// Writes to the shift's activity for the signed-in person. Never blocks the caller.
export function log(event_type, extra = {}) {
  if (!session.user) return;
  logActivity({ actor_id: session.user.id, shift_id: session.shiftId, event_type, ...extra }).catch(() => {});
}

export const isOwner = () => session.user?.role === 'owner';

// Signs this person in to the server with the password they already typed.
// Quietly does nothing when offline; screens retry it when they need it. A
// screen that needs the server while this is still on its way (the first
// screen after sign-in) waits for it rather than making a second login.
let connecting = null; // { userId, attempt } for the sign-in password

export function connectToServer(typed = password) {
  const user = session.user;
  if (!user || !typed) return Promise.resolve(false);
  if (typed === password && connecting?.userId === user.id) return connecting.attempt;

  const attempt = (async () => {
    try {
      const token = await requestToken(user.id, typed);
      if (session.user?.id !== user.id) return false; // they signed out meanwhile
      await saveServerLogin(token);
      password = typed;
      return true;
    } catch {
      return false;
    }
  })();
  if (typed === password) {
    connecting = { userId: user.id, attempt };
    attempt.finally(() => { if (connecting?.attempt === attempt) connecting = null; });
  }
  return attempt;
}

// Runs a server call that needs the person's server login. If that login is
// missing, it's made with the sign-in password; the password is only asked
// for when that isn't possible (e.g. the app was reopened after a refresh).
// A screen still loading when its person signed out (or the till locked)
// never asks the next person for that password.
export async function withServerAuth(fn) {
  const user = session.user;
  try {
    return await fn();
  } catch (err) {
    if (err.name !== 'AuthRequiredError' || err.kind !== 'user') throw err;
    if (!user || session.user !== user) throw err;
    if (await connectToServer()) return fn();
    if (session.user !== user) throw err;

    const typed = await showPrompt('Enter your password', {
      message: 'To open this screen, enter the password you sign in with.',
      type: 'password',
      inputmode: 'numeric',
      confirmLabel: 'Continue',
      onConfirm: async (value) => ((await connectToServer(value)) ? null : "That didn't work. Wrong password, or no internet right now."),
    });

    if (typed === null) throw new Error('Password entry cancelled');
    return fn();
  }
}
