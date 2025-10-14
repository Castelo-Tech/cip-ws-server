import { initFirebaseAdmin, admin } from './firebaseAdmin.js';

function db() {
  initFirebaseAdmin();
  return admin.firestore();
}

/** Express middleware: require Authorization: Bearer <idToken> */
export async function verifyRequestUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    const token = authHeader.slice(7);
    initFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    req.auth = { uid: decoded.uid, email: decoded.email || null, token: decoded };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function getAccountDoc(accountId) {
  const snap = await db().collection('accounts').doc(accountId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() || {} };
}

async function getMemberDoc(accountId, uid) {
  const ref = db().collection('accounts').doc(accountId).collection('members').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() || {} };
}

export async function assertAccountActiveAndMember(accountId, uid) {
  const account = await getAccountDoc(accountId);
  if (!account) throw make403('Account not found');
  if ((account.data.status || 'active') !== 'active') {
    throw make403('Account is not active');
  }
  // Optional: feature flag
  const enabled = account.data?.features?.whatsapp?.enabled;
  if (enabled === false) throw make403('WhatsApp feature disabled for this account');

  const member = await getMemberDoc(accountId, uid);
  if (!member) throw make403('User is not a member of this account');
  if ((member.data.status || 'active') !== 'active') {
    throw make403('Membership is not active');
  }
  return { account, member };
}

export async function assertAccountAdmin(accountId, uid) {
  const { member } = await assertAccountActiveAndMember(accountId, uid);
  const role = String(member.data.role || '').toLowerCase();
  if (role !== 'owner' && role !== 'admin') {
    throw make403('Admin or Owner role required');
  }
  return true;
}

/** Resolve a whatsappSession by label inside an account */
export async function findSessionByLabel(accountId, label) {
  const ref = db().collection('accounts').doc(accountId).collection('whatsappSessions');
  const qs = await ref.where('label', '==', label).limit(1).get();
  if (qs.empty) return null;
  const doc = qs.docs[0];
  return { id: doc.id, data: doc.data() || {} };
}

/** Check ACL permission on session. Fallback: account admin can pass even if ACL missing. */
export async function assertSessionPermission(accountId, label, uid, perm /* 'viewContacts' | 'viewMessages' | 'createMessages' */) {
  // First, user must be active member
  await assertAccountActiveAndMember(accountId, uid);

  const sess = await findSessionByLabel(accountId, label);
  if (!sess) {
    // No session doc yet: allow only Admin/Owner to proceed (init/destroy flows, or legacy labels)
    await assertAccountAdmin(accountId, uid);
    return true;
  }

  const aclRef = db()
    .collection('accounts').doc(accountId)
    .collection('whatsappSessions').doc(sess.id)
    .collection('acl').doc(uid);

  const aclSnap = await aclRef.get();
  if (!aclSnap.exists) {
    // Fallback: Admin/Owner passes if ACL not set
    await assertAccountAdmin(accountId, uid);
    return true;
  }

  const acl = aclSnap.data() || {};
  if (acl[perm] === true) return true;

  // Final fallback for perms: Admin/Owner passes
  try {
    await assertAccountAdmin(accountId, uid);
    return true;
  } catch {
    throw make403(`Missing permission: ${perm}`);
  }
}

function make403(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

/** Helper to standardize error responses inside routes */
export function handleAuthzError(res, error) {
  const status = Number(error?.status) || 403;
  return res.status(status).json({ error: error?.message || 'Forbidden' });
}
