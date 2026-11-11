// Minimal first screen: setup, sign-in, clients. All text is inserted with text nodes (never innerHTML).
const app = document.getElementById('app');
const state = { tab: 'clients', dir: { q: '', category: '', view: 'active', offset: 0, data: null, importResult: '', toolResult: '' }, user: null, clients: [], selected: null, detail: null, message: '', errors: [] };

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  if (tag === 'table') { const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.append(n); return wrap; }
  return n;
}

function brand() {
  return el('div', { class: 'brand' }, el('span', { class: 'brand-mark', 'aria-hidden': 'true' },
    el('img', { src: '/bttt-company-logo.jpg', alt: '', width: '26', height: '39' })),
    el('div', {}, el('strong', {}, 'B3T Ai'), el('small', {}, 'Client operations')));
}
const badge = (text, tone = '') => el('span', { class: 'badge ' + tone }, text);
const metrics = items => el('div', { class: 'metrics' }, items.map(([label, value]) =>
  el('div', { class: 'metric' }, el('strong', {}, value ?? 0), el('span', {}, label))));

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.data = data; throw e; }
  return data;
}

function field(label, name, value = '', type = 'text', hint = '') {
  return el('div', {}, el('label', { for: name }, label), el('input', { id: name, name, type, value, autocomplete: type === 'password' ? (name === 'password' ? 'current-password' : 'new-password') : 'off' }), hint && el('div', { class: 'muted' }, hint));
}
const val = id => document.getElementById(id).value;

function clientSection(id = state.selected) {
  const client = state.clients.find(c => c.id === id);
  return state.user?.role === 'admin' && client && client.ownerId !== state.user.id
    ? 'operator-clients' : 'clients';
}

function render() {
  app.replaceChildren();
  if (state.view === 'setup') return app.append(authCard('Create the first admin account', 'Create account', async () => {
    await api('/api/setup', 'POST', { email: val('email'), password: val('password'), setupToken: document.getElementById('setup-token')?.value });
    state.message = 'Account created. Please sign in.'; state.view = 'login'; render();
  }, 'Use at least 12 characters with upper and lower case letters and a number.'));
  if (state.view === 'login') return app.append(authCard('Sign in', 'Sign in', async () => {
    await api('/api/login', 'POST', { email: val('email'), password: val('password') });
    await boot();
  }));
  if (state.tab === 'health') return app.append(header(), healthPage());
  if (state.tab === 'account') return app.append(header(), accountView());
  if (state.tab === 'directory') return app.append(header(), directoryView());
  if (state.tab === 'discovery-review') return app.append(header(), discoveryReviewPage());
  if (state.tab === 'discovery-history') return app.append(header(), discoveryHistoryPage());
  if (state.tab === 'results' && state.detail) return app.append(header(), el('main', {},
    el('div', { class: 'page-heading' }, el('h1', {}, 'Results'), el('p', { class: 'muted' }, 'Client: ' + (state.detail.displayName || state.detail.id))),
    el('button', { onclick: () => { state.tab = clientSection(); render(); } }, 'Back to client'), clientSitesPanel(true)));
  app.append(header(), el('main', { class: 'two' }, clientList(), state.detail && state.tab === clientSection() ? editor() : welcome()));
}

function authCard(title, button, onSubmit, hint) {
  const err = el('div', { class: 'error', role: 'alert' });
  return el('main', { class: 'auth-layout' }, el('section', {}, brand(),
    el('h1', {}, title), el('p', { class: 'muted' }, 'Your workspace for managing client applications.'), state.message && el('div', { class: 'warn' }, state.message),
    field('Email', 'email', '', 'email'), field('Password', 'password', '', 'password', hint),
    state.view === 'setup' && state.setupTokenRequired && field('Setup code', 'setup-token', '', 'password'),
    err, el('div', { class: 'row' }, el('button', { class: 'primary', onclick: async () => {
      err.textContent = '';
      try { await onSubmit(); } catch (e) { err.textContent = e.message; }
    } }, button))));
}

function header() {
  const tab = (id, label) => el('button', { class: state.tab === id ? 'nav-active' : '', 'aria-current': state.tab === id ? 'page' : null, onclick: async () => { try { if (id === 'health') await loadHealth(); if (id === 'directory') await loadSites(); if (id === 'operator-clients') state.staffUsers = (await api('/api/users')).users; if (id === 'discovery-review') await loadDiscoveryReview(); if (id === 'discovery-history') await loadDiscoveryHistory(); if (['clients', 'operator-clients'].includes(id) && id !== clientSection()) { state.detail = null; state.selected = null; state.cs = null; } state.tab = id; state.notice = ''; } catch (e) { state.notice = 'Could not open ' + label + ': ' + e.message; } render(); } }, label);
  return el('header', {}, state.notice ? el('div', { class: 'error', role: 'alert' }, state.notice) : null,
    el('div', { class: 'brand-nav' }, brand(), el('nav', { 'aria-label': 'Main navigation' }, tab('clients', 'Clients'), state.user.role === 'admin' && tab('operator-clients', 'Operator clients'), tab('directory', 'Site directory'), state.user.role !== 'viewer' && tab('health', state.healthError || state.health?.checks?.some(c => c.status === 'missing' || c.status === 'failed') ? 'System health - needs attention' : 'System health'), state.user.role === 'admin' && tab('discovery-review', 'Discovery review'), state.user.role === 'admin' && tab('discovery-history', 'Discovery history'))),
    el('div', { class: 'user-menu' }, el('span', { class: 'user-email' }, state.user.email), badge(state.user.role),
    el('button', { onclick: () => { state.tab = 'account'; state.accountNotice = ''; state.notice = ''; render(); } }, 'My account'), ' ',
    el('button', { onclick: async () => { await api('/api/logout', 'POST'); state.user = null; state.staffUsers = []; state.operatorFilter = ''; state.tab = 'clients'; state.selected = null; state.detail = null; state.cs = null; state.clients = []; state.logins = null; state.view = 'login'; state.message = ''; render(); } }, 'Sign out')));
}

async function loadHealth(live = false) {
  if (state.healthBusy) return;
  state.healthBusy = true; state.healthError = ''; render();
  try { state.health = await api('/api/health', live ? 'POST' : 'GET', live ? {} : undefined); }
  catch (e) { state.healthError = 'Could not check the app. Make sure B3T Ai and Docker Desktop are running. ' + e.message; }
  finally { state.healthBusy = false; render(); }
}
function healthPage() {
  return el('main', {}, el('h1', {}, 'System health'),
    el('p', { class: 'muted' }, 'Startup checks show configuration. Check connections launches a blank browser and uses one search request and one AI request; provider charges may apply. No client information is sent. Checks are shared for one minute.'),
    state.healthError && el('p', { class: 'error', role: 'alert' }, state.healthError),
    el('button', { disabled: !!state.healthBusy, onclick: () => loadHealth(true) }, state.healthBusy ? 'Checking...' : 'Check connections'),
    state.health && el('p', { class: 'muted' }, 'Last checked: ' + new Date(state.health.checkedAt).toLocaleString()),
    ...(state.health?.checks || []).map(c => el('section', { class: 'result-card' }, el('h2', {}, c.name),
      badge(c.status === 'ready' ? 'Ready' : c.status === 'configured' ? 'Configured - connection not checked' : c.status === 'missing' ? 'Missing setup' : 'Needs attention'),
      el('p', {}, c.detail), c.status !== 'ready' && el('p', {}, c.fix))));
}

function accountView() {
  const out = el('div', { role: 'status' }, state.accountNotice);
  const err = el('div', { class: 'error', role: 'alert' });
  const card = el('div', { class: 'card', style: 'max-width:480px;margin:24px auto' },
    el('h1', {}, 'My account'),
    el('p', { class: 'muted' }, `Signed in as ${state.user.email}. Fill in only what you want to change.`),
    field('Current password (required)', 'acc_current', '', 'password'),
    field('New email', 'acc_email', '', 'email'),
    field('New password', 'acc_new', '', 'password', 'At least 12 characters with upper and lower case letters and a number.'),
    err, out,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: async () => {
        err.textContent = ''; out.textContent = '';
        try {
          const r = await api('/api/me/account', 'POST', { current: val('acc_current'), newEmail: val('acc_email'), newPassword: val('acc_new') });
          state.user = r.user;
          state.accountNotice = 'Saved. Your sign-in email is ' + r.user.email + '.';
          if (state.tab === 'account') render();
        } catch (e) { err.textContent = e.message; }
      } }, 'Save changes'),
      el('button', { onclick: () => { state.tab = clientSection(); render(); } }, 'Back')));
  return el('main', {}, card);
}

function clientList() {
  const clientButtons = rows => el('div', { class: 'list' }, rows.length ? rows.map(c =>
    el('button', { class: c.id === state.selected ? 'active' : '', onclick: () => openClient(c.id) }, c.displayName))
    : el('p', { class: 'muted' }, 'No clients yet.'));
  const admin = state.user.role === 'admin';
  const list = clientButtons(admin ? state.clients.filter(c => c.ownerId === state.user.id) : state.clients);
  const operatorSection = admin && state.tab === 'operator-clients';
  if (operatorSection) {
    const groups = new Map();
    for (const operator of state.staffUsers || []) {
      if (operator.role === 'operator') groups.set(operator.id, { label: operator.email, clients: [] });
    }
    for (const client of state.clients) {
      if (client.ownerId === state.user.id) continue;
      const key = client.ownerId || 'unassigned';
      if (!groups.has(key)) groups.set(key, { label: client.ownerEmail || 'Unassigned legacy clients', clients: [] });
      groups.get(key).clients.push(client);
    }
    const selected = groups.get(state.operatorFilter);
    const options = [...groups].sort(([, a], [, b]) => a.label.localeCompare(b.label));
    return el('section', { class: 'client-sidebar' }, el('h2', {}, 'Operator clients'),
      options.length ? el('div', {},
        el('label', { for: 'operator-filter' }, 'Choose an operator'),
        el('select', { id: 'operator-filter', onchange: event => {
          state.operatorFilter = event.target.value;
          state.selected = null;
          state.detail = null;
          state.cs = null;
          state.logins = null;
          render();
          document.getElementById('operator-filter')?.focus();
        } },
        el('option', { value: '', selected: !selected }, 'Select an operator'),
        options.map(([id, group]) => el('option', { value: id, selected: id === state.operatorFilter }, group.label))),
        selected && clientButtons(selected.clients))
        : el('p', { class: 'muted' }, 'No operator clients yet.'),
      staffAccounts(), addUserForm());
  }
  const canWrite = state.user.role !== 'viewer';
  return el('section', { class: 'client-sidebar' }, el('h2', {}, 'My clients'), list,
    canWrite && el('div', { class: 'row' }, el('button', { class: 'primary', onclick: newClient }, 'New client')));
}

function staffPasswordReset(user, status) {
  const password = el('input', { type: 'password', autocomplete: 'new-password', required: true });
  const button = el('button', { type: 'submit' }, 'Save new password');
  const panel = el('details', {}, el('summary', {}, 'Reset password'),
    el('form', { onsubmit: async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      status.textContent = '';
      try {
        await api('/api/users/' + user.id, 'PATCH', { newPassword: password.value });
        password.value = '';
        panel.open = false;
        status.textContent = 'Password reset for ' + user.email + '. Their existing sessions were signed out.';
      } catch (e) { status.textContent = e.message; }
      finally { button.disabled = false; }
    } }, el('label', {}, 'New password for ' + user.email, password),
    el('p', { class: 'muted' }, 'Saving signs this user out of their existing sessions.'), button));
  panel.addEventListener('toggle', () => { if (!panel.open) password.value = ''; });
  return panel;
}

function staffAccounts() {
  const list = el('div', {});
  const status = el('p', { role: 'status' });
  const load = async () => {
    try {
      const { users } = await api('/api/users');
      list.replaceChildren(...(users.length ? users.map(user =>
        el('div', { class: 'row' }, el('span', {}, user.email + ' (' + user.role + ')'),
          user.role !== 'admin' && el('button', { onclick: async event => {
            const email = prompt('New sign-in email for ' + user.email, user.email);
            if (email === null || email.trim().toLowerCase() === user.email) return;
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const updated = await api('/api/users/' + user.id, 'PATCH', { email });
              await refresh();
              status.textContent = 'Sign-in email changed to ' + updated.user.email + '.';
              await load();
            } catch (e) { status.textContent = e.message; }
            finally { button.disabled = false; }
          } }, 'Edit email'),
          user.role !== 'admin' && staffPasswordReset(user, status),
          el('button', { onclick: async event => {
            if (!confirm('Remove access for ' + user.email + '? Their client records will stay available to admins.')) return;
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await api('/api/users/' + user.id, 'DELETE');
              status.textContent = 'Access removed for ' + user.email + '.';
              await load();
            } catch (e) { status.textContent = e.message; button.disabled = false; }
          } }, 'Remove access')))
        : [el('p', { class: 'muted' }, 'No other active accounts.')]));
    } catch (e) { status.textContent = e.message; }
  };
  return el('section', {}, el('h3', {}, 'Staff accounts'),
    el('button', { onclick: load }, 'Show or refresh staff accounts'), status, list);
}

function addUserForm() {
  const err = el('div', { id: 'staff-add-status', role: 'status' });
  return el('div', {}, el('h3', { style: 'margin-top:20px' }, 'Add a staff user'),
    field('Email', 'nu-email', '', 'email'), field('Password', 'nu-pass', '', 'password'),
    el('label', { for: 'nu-role' }, 'Role'), el('select', { id: 'nu-role' }, ['operator', 'viewer', 'admin'].map(r => el('option', { value: r }, r))),
    err, el('div', { class: 'row' }, el('button', { onclick: async () => {
      err.textContent = '';
      try { await api('/api/users', 'POST', { email: val('nu-email'), password: val('nu-pass'), role: val('nu-role') }); state.staffUsers = (await api('/api/users')).users;
        render();
        document.getElementById('staff-add-status').textContent = 'User added.'; }
      catch (e) { err.textContent = e.message; }
    } }, 'Add user')));
}

function welcome() {
  return el('section', { class: 'welcome-card' }, el('span', { class: 'eyebrow' }, 'Client operations'), el('h1', {}, 'A clearer path from profile to submission.'),
    el('p', { class: 'muted' }, 'Choose a client to manage their profile, review permissions, and track applications across your site directory.'),
    el('div', { class: 'workflow' },
      [['01', 'Build the profile', 'Keep client details and permissions together.'], ['02', 'Prepare applications', 'Match sites and review filled forms.'], ['03', 'Track the outcome', 'Follow confirmations and items needing attention.']].map(([number, title, text]) =>
        el('div', {}, el('span', { class: 'step-number' }, number), el('strong', {}, title), el('span', { class: 'muted' }, text)))),
    el('p', { class: 'muted', style: 'margin-top:28px' }, 'Client details are encrypted before saving. Record access and changes appear in the activity log.'));
}

const TEXT_FIELDS = [['firstName', 'Legal first name'], ['lastName', 'Legal last name'], ['preferredName', 'Preferred name'], ['email', 'Email'],
  ['phone', 'Phone'], ['dateOfBirth', 'Date of birth (MM-DD-YYYY, only if needed)'], ['addressLine1', 'Street address'], ['addressLine2', 'Address line 2'],
  ['city', 'City'], ['state', 'State'], ['postalCode', 'Postal code'], ['country', 'Country']];
const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const stateCode = v => { const t = String(v || '').trim(); if (US_STATES[t.toUpperCase()]) return t.toUpperCase(); return Object.entries(US_STATES).find(([, n]) => n.toLowerCase() === t.toLowerCase())?.[0] ?? ''; };
const dobShow = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? `${m[2]}-${m[3]}-${m[1]}` : (v || ''); };
const dobStore = v => { const m = /^\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\s*$/.exec(v); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : v.trim(); };
const fieldInput = (k, p, readOnly) => {
  if (k === 'state') return el('select', { id: 'f-state', disabled: readOnly }, el('option', { value: '' }, 'Choose...'),
    Object.entries(US_STATES).map(([a, n]) => el('option', { value: a, selected: stateCode(p.state) === a }, `${n} (${a})`)));
  if (k === 'country') return el('select', { id: 'f-country', disabled: readOnly }, el('option', { value: 'United States' }, 'United States'));
  if (k === 'dateOfBirth') return el('input', { id: 'f-dateOfBirth', value: dobShow(p.dateOfBirth), placeholder: 'MM-DD-YYYY', maxlength: '10', disabled: readOnly });
  return el('input', { id: 'f-' + k, value: p[k] ?? '', disabled: readOnly });
};
const SITE_COUNTS = [['10', '10 sites'], ['25', '25 sites'], ['50', '50 sites'], ['100', '100 sites'], ['250', '250 sites'], ['500', '500 sites'], ['all', 'All matching sites']];

function editor() {
  const d = state.detail, p = d.profile, isNew = !d.id, readOnly = state.user.role === 'viewer';
  const err = el('div', { id: 'client-save-errors', class: 'error', role: 'alert' }, state.errors.map(e => el('div', {}, e)));
  return el('section', {},
    el('div', { class: 'page-heading' }, el('span', { class: 'eyebrow' }, isNew ? 'Client intake' : 'Client workspace'), el('h2', {}, isNew ? 'New client' : d.displayName || 'Client profile'), el('p', { class: 'muted' }, 'Manage profile details, permissions, and applications.')),
    d.missing?.length ? el('div', { class: 'warn' }, 'Still needed: ' + d.missing.join(', ')) : null,
    el('label', { for: 'displayName' }, 'Label shown in the client list'),
    el('input', { id: 'displayName', value: d.displayName, disabled: readOnly }),
    el('div', { class: 'muted' }, 'Use initials or a case number here, not the full name. The label is not encrypted. The details below are.'),
    el('div', { class: 'grid2' }, TEXT_FIELDS.map(([k, label]) => el('div', {}, el('label', { for: 'f-' + k }, label),
      fieldInput(k, p, readOnly)))),
    el('label', { for: 'f-siteCount' }, 'How many sites does this client want to join?'),
    el('select', { id: 'f-siteCount', disabled: readOnly }, el('option', { value: '' }, 'Choose...'),
      SITE_COUNTS.map(([v, t]) => el('option', { value: v, selected: p.siteCount === v }, t))),
    el('div', { class: 'muted' }, 'Only sites that need no staff count toward this number. Sites that need staff are added on top for an admin to handle or skip. This is a limit, not a promise. Sites that cost money or renew automatically still need the client\'s separate approval.'),
    el('p', { class: 'muted' }, 'Social Security numbers, card numbers and similar are never stored. A person types them directly into the website.'),
    isNew && el('div', {}, el('label', {}, el('input', { id: 'consent', type: 'checkbox', style: 'width:auto' }), ' The client has authorized using this information to apply on their behalf')),
    err,
    !readOnly && el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Save')),
    !isNew && consents(d.consents), !isNew && !readOnly && el('div', { class: 'row' },
      state.user.role === 'admin' && el('button', { onclick: showActivity }, 'View activity log'),
      el('button', { onclick: removeClient }, 'Delete client')),
    el('div', { id: 'activity' }),
    !isNew && state.cs && clientSitesPanel(),
    !isNew && state.user.role === 'admin' && loginsPanel());
}

const PERMISSIONS = [
  ['use_profile_for_applications', 'Apply on this client behalf using their saved profile'],
  ['accept_site_terms', 'Accept website terms and age confirmations for this client'],
  ['marketing_opt_in', 'Tick offer and newsletter boxes for this client'],
  ['create_accounts', 'Make up a username and password and create accounts for this client'],
];
function consents(list) {
  const canWrite = state.user.role !== 'viewer';
  const active = scope => list.some(c => c.scope === scope && !c.revokedAt);
  const change = async (scope, revoke) => { await api('/api/clients/' + state.detail.id + '/consents', 'POST', { scope, revoke }); await openClient(state.detail.id); };
  const others = list.filter(c => !PERMISSIONS.some(([k]) => k === c.scope));
  return el('div', { id: 'client-permissions' }, el('h3', { style: 'margin-top:16px' }, 'What this client has allowed'),
    el('p', { class: 'muted' }, 'The software only does these things automatically when the box is recorded here. Anything not recorded is left to a person.'),
    PERMISSIONS.map(([scope, text]) => el('div', { class: 'row', style: 'align-items:center' },
      el('span', {}, (active(scope) ? '✔ ' : '✘ ') + text),
      canWrite && el('button', { onclick: () => change(scope, active(scope)) }, active(scope) ? 'Remove' : 'Record permission'))),
    el('h3', { style: 'margin-top:16px' }, 'Consent records'),
    others.length ? el('ul', {}, others.map(c => el('li', {}, `${c.scope} (${new Date(c.grantedAt).toLocaleDateString()})${c.revokedAt ? ' - removed' : ''}`))) : el('p', { class: 'muted' }, 'None recorded yet.'));
}

function collect() {
  const profile = { ...state.detail.profile };
  for (const [k] of TEXT_FIELDS) profile[k] = k === 'dateOfBirth' ? dobStore(val('f-' + k)) : val('f-' + k);
  const sc = val('f-siteCount'); if (sc) profile.siteCount = sc; else delete profile.siteCount;
  return profile;
}

async function save(event) {
  const button = event.currentTarget;
  const errorBox = document.getElementById('client-save-errors');
  const detail = state.detail;
  if (button.disabled) return;
  button.disabled = true;
  state.errors = [];
  errorBox.replaceChildren();
  let id = detail.id;
  try {
    const profile = collect(), displayName = val('displayName');
    if (!id) {
      const consents = document.getElementById('consent')?.checked ? ['use_profile_for_applications'] : [];
      const result = await api('/api/clients', 'POST', { displayName, profile, consents });
      id = result.id;
      if (state.detail === detail) { detail.id = id; state.selected = id; }
    } else {
      await api('/api/clients/' + id, 'PUT', { displayName, profile });
    }
  } catch (e) {
    if (errorBox.isConnected) {
      const messages = e.data?.errors ?? [e.message];
      errorBox.replaceChildren(...messages.map(message => el('div', {}, message)));
    }
    button.disabled = false;
    return;
  }

  try {
    await refresh();
    if (state.detail === detail && errorBox.isConnected) await openClient(id);
  } catch {
    if (errorBox.isConnected) errorBox.textContent = 'Client saved. Refresh the page to reload the client list.';
  } finally {
    button.disabled = false;
  }
}

async function newClient() { state.tab = 'clients'; state.selected = null; state.errors = []; state.detail = { id: null, displayName: '', profile: {}, consents: [], missing: [] }; render(); }
async function openClient(id) {
  state.tab = clientSection(id); state.selected = id; state.errors = []; state.detail = await api('/api/clients/' + id + '');
  state.cs = { status: '', offset: 0, data: null, notice: '' }; state.logins = null; await loadClientSites(); render();
}
function loginsPanel() {
  const L = state.logins;
  const show = async () => { try { state.logins = { error: '', rows: (await api('/api/clients/' + state.detail.id + '/logins')).logins, revealed: {} }; } catch (e) { state.logins = { error: e.message, rows: [], revealed: {} }; } render(); };
  return el('div', { style: 'margin-top:16px' },
    el('h3', {}, 'Logins made for this client (admins only)'),
    el('p', { class: 'muted' }, 'Usernames and passwords the software made up when it created accounts for this client. Opening this list is recorded in the activity log.'),
    !L && el('button', { onclick: show }, 'Show logins'),
    L && L.error && el('div', { class: 'error', role: 'alert' }, L.error),
    L && !L.error && (L.rows.length
      ? el('table', {}, el('tr', {}, el('th', {}, 'Site'), el('th', {}, 'Username'), el('th', {}, 'Password'), el('th', {}, 'Made')),
          L.rows.map(r => el('tr', {},
            el('td', {}, r.siteName, el('div', { class: 'muted' }, r.domain)),
            el('td', {}, r.username || '(none)'),
            el('td', {}, L.revealed[r.id] ? r.password : '••••••••  ', el('button', { onclick: () => { L.revealed[r.id] = !L.revealed[r.id]; render(); } }, L.revealed[r.id] ? 'Hide' : 'Show')),
            el('td', {}, new Date(r.createdAt).toLocaleString()))))
      : el('p', { class: 'muted' }, 'No logins have been made for this client yet.')));
}
const CS_PAGE = 50;
const CS_LABEL = { proposed: 'Suggested', sent: 'Needs verification', approved: 'Approved', skipped: 'Skipped', staff_fill: 'Staff will fill this', done: 'Marked done by staff (not checked by the software)' };
/** Notes: green when the site is done, red when nothing was sent, the normal colour when sent but not yet confirmed. */
function noteStyle(s) {
  if (s.status === 'done') return 'color:#067647;font-weight:600';
  if (s.status === 'sent') return '';
  if (/not sent|nothing was sent|did not accept|prove we are human|not accept/i.test(s.note || '')) return 'color:#b42318;font-weight:600';
  return '';
}
async function loadClientSites() {
  const c = state.cs, qs = new URLSearchParams({ limit: String(CS_PAGE), offset: String(c.offset) });
  if (c.status === 'already' || c.status === 'likely') qs.set('tag', c.status); else if (c.status === 'captcha') qs.set('captcha', '1'); else if (c.status === 'restored') qs.set('restored', '1'); else if (c.status === 'approved_note') { qs.set('status', 'approved'); qs.set('hasNote', '1'); } else if (c.status) qs.set('status', c.status);
  const resultsQuery = new URLSearchParams({ limit: '10', offset: String(c.resultOffset || 0) });
  if (c.resultFilter) resultsQuery.set('delivery', c.resultFilter);
  if (c.showDismissed) resultsQuery.set('includeDismissed', '1');
  const [sites, history] = await Promise.all([api('/api/clients/' + state.detail.id + '/sites?' + qs), api('/api/clients/' + state.detail.id + '/results?' + resultsQuery).catch(e => ({ error: e.message }))]);
  c.data = sites; c.history = history;
  if (state.user.role !== 'viewer') c.batches = await api('/api/clients/' + state.detail.id + '/batches').catch(e => ({ error: e.message }));
}
function clientSitesPanel(resultsOnly = false) {
  const c = state.cs, id = state.detail.id, data = c.data, canWrite = state.user.role !== 'viewer';
  const reload = async () => { await loadClientSites(); render(); };
  const set = async (siteId, status, note) => { try { await api('/api/clients/' + id + '/sites/' + siteId, 'POST', { status, note }); c.notice = ''; await reload(); } catch (e) { c.notice = e.message; render(); } };
  const btn = (label, fn) => el('button', { onclick: fn }, label);
  const rows = (data?.sites ?? []).map(s => {
    const href = safeHref(s.url);
    return el('tr', {},
      el('td', {}, href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, s.name) : s.name, el('div', { class: 'muted' }, s.domain),
        state.user.role === 'admin' && el('div', {}, el('a', { href: '#', style: 'font-size:0.9em', onclick: async ev => {
          ev.preventDefault();
          const d = state.dir; d.q = s.domain; d.category = ''; d.view = 'all'; d.offset = 0;
          d.toolResult = 'Showing ' + s.domain + '. Press "Set sign-up page" on its row and paste the exact sign-up page address. Then press the Clients tab to go back to the client.';
          try { await loadSites(); state.tab = 'directory'; state.notice = ''; } catch (e) { c.notice = 'Could not open the site directory: ' + e.message; }
          render();
        } }, 'Fix sign-up page in the Site directory'),
          ' | ', el('a', { href: '#', style: 'font-size:0.9em;color:#b42318', onclick: async ev => {
            ev.preventDefault();
            const reason = prompt('Remove ' + s.name + ' from the whole Site directory (for all clients)? It is replaced by a working site if one is waiting, and you can restore it later from Removed sites.\n\nWhy remove it?', 'does not work');
            if (reason === null) return;
            try { const r = await api('/api/sites/' + s.siteId + '/remove', 'POST', { reason }); c.notice = s.name + ' removed. ' + (r.replacedBy?.length ? 'Replaced with: ' + r.replacedBy.join(', ') : 'No similar replacement was waiting.'); }
            catch (e) { c.notice = e.message; }
            await reload();
          } }, 'Remove from directory'))),
      el('td', {}, badge(s.needsStaff ? 'Staff assistance' : 'Automatic fill', s.needsStaff ? 'pending' : 'info')),
      el('td', {}, badge(s.status === 'done' && /^Confirmed by the site/.test(s.note || '') ? 'Confirmed by site' : (CS_LABEL[s.status] ?? s.status), s.status === 'done' ? 'good' : s.status === 'approved' ? 'info' : ['sent', 'staff_fill'].includes(s.status) ? 'pending' : ''), s.note && el('div', { class: 'site-note ' + (s.status === 'sent' ? 'muted' : ''), style: noteStyle(s) }, 'Note: ' + s.note)),
      canWrite && el('td', {},
        s.status === 'proposed' || s.status === 'skipped' ? [
          s.needsStaff ? btn('Staff will fill this', () => set(s.siteId, 'staff_fill')) : btn('Approve', () => set(s.siteId, 'approved')),
          s.status === 'proposed' && btn('Skip', () => set(s.siteId, 'skipped')),
          s.status === 'skipped' && btn('Undo skip', () => set(s.siteId, 'proposed'))]
        : [s.status === 'approved' && !s.needsStaff && btn('Send now', () => sendNow(s)),
           s.status === 'approved' && !s.needsStaff && btn('Preview first', () => prepare(s)),
           s.status === 'approved' && s.needsStaff && btn('Staff will fill this', () => set(s.siteId, 'staff_fill')),
           (s.status === 'approved' || s.status === 'staff_fill') && s.url && (!s.needsStaff || (state.user.role === 'admin' && /captcha/i.test(s.handlingReason || ''))) && btn('Fill it, I finish (CAPTCHA)', () => handFinish(s)),
           s.status === 'sent' && btn('Allow another attempt', () => { if (confirm('First check the site and confirmation email. Only allow another attempt if you verified that this application did not go through. Have you checked and want to allow another attempt?')) set(s.siteId, 'approved', 'Staff verified the previous attempt before allowing a retry.'); }),
           (s.status === 'staff_fill' || s.status === 'sent') && btn(s.status === 'sent' ? 'I checked: it was sent, mark done' : 'Mark done', () => {
             if (s.status === 'sent') { if (confirm('Mark ' + s.name + ' as sent? Only do this after you checked by hand (for example a confirmation email or message).')) set(s.siteId, 'done', 'Checked by hand by staff: it was sent'); return; }
             const n = prompt('How do you know it is done? (for example the confirmation message). Do not type personal details.'); if (n) set(s.siteId, 'done', n); }),
           s.status === 'staff_fill' && !s.needsStaff && btn('Move back to Approved', () => set(s.siteId, 'approved')),
           btn('Skip', () => set(s.siteId, 'skipped')), btn('Move back to suggested', () => { set(s.siteId, 'proposed').then(() => { c.notice = s.name + ' was moved back to Suggested. It is not deleted: set the Show list to Suggested or All to see it.'; render(); }); })]));
  });
  const showResults = (results, extra) => {
    const n = k => results.filter(x => x.outcome === k).length;
    c.results = { summary: `${results.length} attempts: ${n('confirmed')} confirmed, ${n('unconfirmed') + n('already')} need verification, ${n('captcha')} need a human check, ${n('not_sent')} stopped before sending.` + (extra || ''), items: results };
  };
  const sendNow = async s => {
    if (!confirm('Fill in and send the form for ' + s.name + ' now, without a preview? The result will be shown here.')) return;
    c.notice = ''; c.busy = 'Sending to ' + s.name + '... this can take up to a minute.'; render();
    try { const r = await api('/api/clients/' + id + '/sites/' + s.siteId + '/send-now', 'POST', {}); showResults(r.results); }
    catch (e) { c.notice = e.message; }
    c.busy = ''; await reload();
  };
  const moveCaptcha = async () => {
    if (!confirm('Move every approved site whose note mentions a CAPTCHA or "prove you are human" into the CAPTCHA list? They leave the approved list. Nothing is sent.')) return;
    try { const r = await api('/api/clients/' + id + '/sites/move-captcha', 'POST', {}); c.notice = r.count + ' sites moved to the CAPTCHA list (Show > CAPTCHA sites).'; }
    catch (e) { c.notice = e.message; }
    await reload();
  };
  const moveAlready = async () => {
    if (!confirm('Move every approved site whose note says the person is already a member or subscribed into the "Already a member (verify)" list? They leave the approved list. Nothing is sent.')) return;
    try { const r = await api('/api/clients/' + id + '/sites/move-already', 'POST', {}); c.notice = r.count + ' sites moved to the list (Show > Already a member / subscribed). Check a few by hand, then press "I checked: it was sent, mark done" on the ones that are fine.'; }
    catch (e) { c.notice = e.message; }
    await reload();
  };
  const scanCaptcha = async () => {
    const par = Math.min(16, Math.max(1, parseInt(val('scan-par'), 10) || 8));
    if (!confirm('Look at every approved site (only looking, nothing is typed or sent) and move the ones that show a CAPTCHA to the CAPTCHA list? This can take a long time for many sites. Press Stop to pause.')) return;
    c.stop = false; c.sendingAll = true; c.notice = ''; const tried = []; let moved = 0, seen = 0, remaining = 0;
    try {
      while (!c.stop) {
        c.busy = `Looking for CAPTCHAs... ${seen} sites looked at, ${moved} moved to the CAPTCHA list. Press Stop to pause.`; render();
        const r = await api('/api/clients/' + id + '/sites/scan-captcha', 'POST', { limit: par, skip: tried });
        tried.push(...r.results.map(x => x.siteId)); seen += r.results.length; moved += r.results.filter(x => x.captcha).length; remaining = r.remaining;
        if (!r.results.length || remaining === 0) break;
      }
    } catch (e) { c.notice = e.message; }
    c.notice = `${seen} sites looked at, ${moved} moved to the CAPTCHA list.` + (remaining ? ` ${remaining} approved sites not looked at yet.` : '') + (c.notice ? ' ' + c.notice : '');
    c.busy = ''; c.sendingAll = false; await reload();
  };
  const openCaptchaBatch = async () => {
    const par = Math.min(10, Math.max(1, parseInt(val('captcha-par'), 10) || 5)); c.captchaPar = par;
    if (!confirm('Open up to ' + par + ' browser windows on this computer, each with a form filled in? In each one you solve the CAPTCHA and press Send yourself. The software sends nothing.')) return;
    c.notice = ''; c.busy = 'Opening ' + par + ' windows and filling the forms... this can take a minute. Windows will appear on this computer.'; render();
    try {
      const r = await api('/api/clients/' + id + '/sites/captcha-batch', 'POST', { limit: par });
      const ok = r.results.filter(x => x.ok), bad = r.results.filter(x => !x.ok);
      c.notice = `${ok.length} windows are open: ${ok.map(x => x.name).join(', ') || 'none'}. Solve each CAPTCHA, press Send, then press "Mark done" here for the ones that went through.` + (bad.length ? ` Could not open: ${bad.map(x => x.name + ' (' + x.text + ')').join('; ')}.` : '') + (r.remaining ? ` ${r.remaining} more are waiting: press the button again when you are ready.` : ' That is the last of them.');
    } catch (e) { c.notice = e.message; }
    c.busy = ''; await reload();
  };
  const cleanFailed = async (action, opts = {}) => {
    const ro = opts.restoredOnly === true;
    const msg = ro ? 'Remove for good every restored site that still has a "Not sent" note? They will not be put back by re-checks.' : action === 'remove'
      ? 'Remove every approved site that has a "Not sent" note from the whole Site directory (for all clients)? They can be restored later from the removed list.'
      : 'Move every approved site that has a "Not sent" note to Skipped for this client? Sites whose note says the form was probably not accepted are left alone, because they may have gone through.';
    if (!confirm(msg)) return;
    const word = action === 'remove' ? 'removed from the directory' : 'moved to Skipped';
    try {
      const r = await api('/api/clients/' + id + '/sites/clean-failed', 'POST', { action, restoredOnly: ro });
      c.notice = r.count + ' sites ' + word + (ro ? ' and marked DO NOT WORK (see Site directory > Removed).' : '.');
      if (!ro && r.left > 0 && confirm(r.left + ' sites are still in this list. Their note says the site did not accept the form, so some of them may actually have gone through (check a few by hand, for example by the confirmation email).\n\nPress OK to ' + (action === 'remove' ? 'remove' : 'move') + ' these ' + r.left + ' as well, or Cancel to keep them for checking.')) {
        const r2 = await api('/api/clients/' + id + '/sites/clean-failed', 'POST', { action, all: true, restoredOnly: ro });
        c.notice += ' Then ' + r2.count + ' more ' + word + '.';
      } else if (r.left > 0) c.notice += ' ' + r.left + ' were kept because they may have gone through: check them by hand.';
    }
    catch (e) { c.notice = e.message; }
    await reload();
  };
  const handFinish = async s => {
    if (!confirm('Open ' + s.name + ' in a window on this computer with the form filled in? You then solve the CAPTCHA (if any) and press Send yourself. Afterwards press "Mark done" here once you checked it went through.')) return;
    c.notice = ''; c.busy = 'Opening ' + s.name + ' and filling the form... a window will appear on this computer.'; render();
    try { const r = await api('/api/clients/' + id + '/sites/' + s.siteId + '/hand-finish', 'POST', {}); c.notice = 'The window for ' + s.name + ' is open. Finish it there, then come back and press "Mark done".' + (r.leftForYou?.length ? ' Left for you: ' + r.leftForYou.join('; ') : ''); }
    catch (e) { c.notice = e.message; }
    c.busy = ''; await reload();
  };
  const sendAll = async (opts = {}) => {
    if (c.sendingAll || c.checkingReadiness) return;
    const restoredOnly = opts.restoredOnly === true;
    if (!opts.readyToSend && !opts.resumeRunId) {
      c.batchParallel = Math.min(12, Math.max(1, parseInt(document.getElementById('send-par')?.value, 10) || c.batchParallel || 10));
      c.checkingReadiness = true; c.notice = 'Checking the saved client profile and eligible sites…'; render();
      try { c.readiness = await api('/api/clients/' + id + '/readiness?restoredOnly=' + (restoredOnly ? '1' : '0')); c.notice = ''; }
      catch (e) { c.notice = e.message; }
      c.checkingReadiness = false; render();
      document.getElementById('batch-readiness')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (!opts.resumeRunId && (!c.readiness?.canStart || c.readiness.restoredOnly !== restoredOnly)) return;
    if (opts.resumeRunId && !confirm('Resume untouched sites only? Completed attempts and sites awaiting verification will be skipped.')) return;
    c.readiness = null;
    const par = Math.min(12, Math.max(1, parseInt(val('send-par'), 10) || 10));
    c.stop = false; c.sendingAll = true; c.notice = ''; const all = []; const tried = []; let remaining = 0; let batchMessage = '';
    try {
      const saved = opts.resumeRunId ? { runId: opts.resumeRunId } : await api('/api/clients/' + id + '/batches', 'POST', { restoredOnly });
      while (!c.stop) {
        c.busy = `Sending, several sites at a time... ${all.length} finished so far. Press Stop to pause after the sites in progress.`; render();
        const r = await api('/api/clients/' + id + '/batches/' + saved.runId + '/next', 'POST', { limit: par });   // never retried automatically: a retry could send the same sites twice
        all.push(...r.results); tried.push(...r.results.map(x => x.siteId)); remaining = r.remaining; if (r.message) batchMessage = r.message;
        showResults(all, batchMessage ? ' ' + batchMessage : remaining ? ` ${remaining} approved sites are still waiting.` : '');
        await loadClientSites(); render();
        if (!r.results.length || remaining === 0) break;
      }
    } catch (e) { c.notice = e.message; }
    showResults(all, batchMessage ? ' ' + batchMessage : remaining ? ` ${remaining} approved sites are still waiting.` : '');
    c.busy = ''; c.sendingAll = false; await reload();
  };
  const prepare = async s => {
    c.notice = ''; c.prep = { site: s.name, loading: true }; render();
    try { c.prep = { site: s.name, siteId: s.siteId, ...(await api('/api/clients/' + id + '/sites/' + s.siteId + '/prepare', 'POST', {})) }; }
    catch (e) { c.prep = null; c.notice = e.message; }
    await reload();
  };
  const closePrep = async () => { const p = c.prep; c.prep = null; if (p?.prepId) { try { await api('/api/preps/' + p.prepId + '/cancel', 'POST', {}); } catch { /* already gone */ } } render(); };
  const approve = async () => {
    const p = c.prep; if (!p?.prepId) return;
    if (!confirm('Send this form for the client now?')) return;
    p.sending = true; render();
    try { const r = await api('/api/preps/' + p.prepId + '/approve', 'POST', {}); c.prep = null; c.notice = r.result.detail + (r.result.evidence ? ' The page said: ' + r.result.evidence : ''); }
    catch (e) { c.prep = null; c.notice = e.message; }
    await reload();
  };
  const preview = () => {
    const p = c.prep; if (!p) return null;
    if (p.loading) return el('div', { class: 'warn' }, `Opening ${p.site} and filling the form... this can take up to a minute.`);
    const list = (title, items) => items?.length ? el('div', {}, el('strong', {}, title), el('ul', {}, items.map(x => el('li', {}, x)))) : null;
    return el('div', { class: 'warn' },
      el('h3', {}, `${p.site}: ${p.status === 'ready_for_approval' ? 'ready for your approval. Nothing has been sent.' : 'not sent'}`),
      el('p', {}, p.reason),
      list('Filled in', p.filled), list('AI matched (check these fields carefully)', p.aiMapped), list('Ticked (the client allowed this)', p.ticked),
      p.createsLogin && el('p', {}, 'A username and password will be made and saved for admins just before sending.'),
      list('A person has to handle', p.needsHuman), list('Left empty', p.skipped),
      p.prepId && p.hasScreenshot && el('div', {}, el('p', { class: 'muted' }, 'Picture of the filled form (contains the client\'s details):'), el('img', { src: '/api/preps/' + p.prepId + '/screenshot', alt: 'The filled form', style: 'max-width:100%;border:1px solid #ccc' })),
      el('div', { class: 'row' },
        p.prepId && el('button', { class: 'primary', disabled: !!p.sending, onclick: approve }, p.sending ? 'Sending...' : 'Approve and send'),
        el('button', { onclick: closePrep }, p.prepId ? 'Cancel' : 'Close')));
  };
  const readinessPanel = () => {
    const r = c.readiness;
    if (!r) return null;
    const permissionNames = [['use_profile_for_applications', 'Apply on the client’s behalf'], ['accept_site_terms', 'Accept site terms'], ['marketing_opt_in', 'Marketing opt-in'], ['create_accounts', 'Create site accounts']];
    return el('section', { id: 'batch-readiness', class: 'result-card', role: 'region', 'aria-label': 'Batch readiness' },
      el('h3', {}, r.restoredOnly ? 'Before sending: restored sites only' : 'Before sending: approved sites'),
      el('p', { class: 'muted' }, 'This uses the saved client profile. Save any profile edits before checking again. No forms have been opened or sent by this check.'),
      metrics([['Eligible to send', r.counts.eligible], ['Awaiting approval', r.counts.awaitingApproval], ['Already sent or completed', r.counts.alreadySent], ['Needs staff', r.counts.needsStaff]]),
      r.counts.missingUrl > 0 && el('p', {}, r.counts.missingUrl + ' approved sites have no signup URL.'),
      r.blockers.length > 0 && el('div', { class: 'error' }, el('strong', {}, 'Resolve before starting'), el('ul', {}, r.blockers.map(x => el('li', {}, x)))),
      el('h4', {}, 'Recorded permissions'),
      el('ul', {}, permissionNames.map(([key, label]) => el('li', {}, label + ': ' + (r.permissions.includes(key) ? 'recorded' : 'not recorded')))),
      el('p', { class: 'muted' }, 'Optional permissions are only needed when a site asks for them. Record permission only when the client has granted it.'),
      r.missingInformation.length > 0 ? el('div', {}, el('h4', {}, 'Common profile information missing'), el('ul', {}, r.missingInformation.map(x => el('li', {}, x))), el('p', { class: 'muted' }, 'These are general reminders. Requirements vary by site; forms needing missing information will stop for review.')) : el('p', {}, 'Common profile information is present.'),
      el('p', {}, 'Starting sends the eligible approved forms without individual previews. Each site still gets its normal form and permission checks.'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', disabled: !r.canStart || !!c.sendingAll || !!c.checkingReadiness, onclick: () => sendAll({ restoredOnly: r.restoredOnly, readyToSend: true }) }, 'Start batch (' + r.counts.eligible + ' eligible)'),
        btn('Check again', () => sendAll({ restoredOnly: r.restoredOnly })),
        btn('Review profile', () => { c.readiness = null; state.tab = clientSection(); render(); document.getElementById('f-firstName')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }),
        btn('Review permissions', () => { c.readiness = null; state.tab = clientSection(); render(); document.getElementById('client-permissions')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }),
        btn('Cancel batch', () => { c.readiness = null; render(); })));
  };
  const k = data?.counts;
  const historyPanel = () => {
    const h = c.history;
    if (h?.error) return el('div', { class: 'warn', role: 'status' }, el('strong', {}, 'Saved results could not be loaded.'), el('p', {}, h.error), btn('Refresh results', reload));
    if (!h || !h.counts) return null;
    const showDirectory = async r => {
      state.dir.q = r.domain; state.dir.view = 'all'; state.dir.offset = 0; state.dir.category = '';
      state.dir.toolResult = 'Review the signup address for ' + r.name + ', then return to this client and preview the form.';
      try { await loadSites(); state.tab = 'directory'; render(); } catch (e) { c.notice = e.message; render(); }
    };
    const cards = (h.entries || []).map(r => {
      const o = r.outcome, href = safeHref(r.url);
      const tone = o.delivery === 'confirmed' ? 'good' : o.delivery === 'not_sent' ? 'bad' : 'pending';
      const actions = [];
      if (canWrite) actions.push(btn(r.dismissed ? 'Restore result' : 'Dismiss result', async () => {
        try { await api('/api/clients/' + id + '/results/' + r.id + (r.dismissed ? '/restore' : '/dismiss'), 'POST', {}); c.resultOffset = 0; await reload(); }
        catch (e) { c.notice = e.message; render(); }
      }));
      if (r.dismissed) actions.push(el('span', { class: 'muted' }, 'Dismissed'));
      if (href && o.nextAction !== 'none') actions.push(el('a', { class: 'result-link', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open site to verify'));
      if (canWrite && o.nextAction === 'profile') actions.push(btn('Review client profile', () => { state.tab = clientSection(); render(); const input = document.getElementById('f-firstName'); input?.scrollIntoView({ block: 'center', behavior: 'smooth' }); input?.focus(); }));
      if (canWrite && o.nextAction === 'permissions') actions.push(btn('Review permissions', () => { state.tab = clientSection(); render(); document.getElementById('client-permissions')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }));
      if (state.user.role === 'admin' && o.nextAction === 'signup_page') actions.push(btn('Review signup address', () => showDirectory(r)));
      if (canWrite && o.nextAction === 'manual' && !r.needsStaff && ['approved', 'staff_fill'].includes(r.siteStatus)) actions.push(btn('Open hand-fill window', () => handFinish(r)));
      if (canWrite && o.retryAllowed && r.siteStatus === 'approved' && !r.needsStaff) actions.push(btn('Preview a new attempt', () => prepare({ name: r.name, siteId: r.siteId })));
      return el('article', { class: 'result-card', 'aria-label': r.name + ': ' + o.title },
        el('div', { class: 'result-card-heading' }, el('div', {}, el('h4', {}, r.name), el('div', { class: 'muted' }, r.domain)), badge(o.title, tone)),
        el('time', { class: 'muted', datetime: r.at }, new Date(r.at).toLocaleString()),
        el('p', {}, o.detail),
        o.evidence && el('div', { class: 'result-evidence' }, el('strong', {}, 'Evidence from the site'), el('blockquote', {}, o.evidence)),
        el('p', { class: 'result-guidance' }, el('strong', {}, 'Next step: '), o.guidance),
        actions.length > 0 && el('div', { class: 'row' }, actions));
    });
    return el('div', { class: 'results-panel' },
      el('div', { class: 'page-heading' }, el('span', { class: 'eyebrow' }, 'Saved attempt history'), el('h3', {}, 'Submission results'), el('p', { class: 'muted' }, 'Results stay with this client after a refresh. Check uncertain attempts before sending again. Dismiss reviewed results to clear the active list. Show dismissed results to restore them. Counts include the results currently shown.')),
      metrics([['Confirmed attempts', h.counts.confirmed], ['Needs verification', h.counts.unconfirmed], ['Stopped before sending', h.counts.not_sent]]),
      el('div', { class: 'row' }, el('div', {}, el('label', { for: 'result-filter' }, 'Result type'), el('select', { id: 'result-filter', onchange: async () => { c.resultFilter = val('result-filter'); c.resultOffset = 0; await reload(); } },
        [['', 'All attempts'], ['unconfirmed', 'Needs verification'], ['not_sent', 'Stopped before sending'], ['confirmed', 'Confirmed by the site']].map(([value, title]) => el('option', { value, selected: (c.resultFilter || '') === value }, title)))),
        btn('Refresh results', reload),
        el('label', {}, el('input', { type: 'checkbox', checked: !!c.showDismissed, onchange: async ev => { c.showDismissed = ev.target.checked; c.resultOffset = 0; await reload(); } }), ' Show dismissed')),
      cards.length ? el('div', { class: 'result-list' }, cards) : el('p', { class: 'muted' }, c.resultFilter ? 'No saved attempts match this filter.' : 'No active results. New attempts will appear here. Turn on Show dismissed to view results you cleared.'),
      h.total > 10 && el('div', { class: 'row' },
        el('button', { disabled: !c.resultOffset, onclick: async () => { c.resultOffset = Math.max(0, (c.resultOffset || 0) - 10); await reload(); } }, 'Newer results'),
        el('span', { class: 'muted' }, `${(c.resultOffset || 0) + 1}–${Math.min((c.resultOffset || 0) + 10, h.total)} of ${h.total}`),
        el('button', { disabled: (c.resultOffset || 0) + 10 >= h.total, onclick: async () => { c.resultOffset = (c.resultOffset || 0) + 10; await reload(); } }, 'Older results')));
  };
  if (resultsOnly) return el('section', {}, c.notice && el('div', { class: 'warn', role: 'status' }, c.notice), preview(), historyPanel());
  return el('div', { style: 'margin-top:16px' },
    el('h3', {}, 'Sites for this client'),
    k && metrics([['Suggested', k.proposed], ['Ready to send', k.approved], ['Awaiting confirmation', k.sent], ['Needs staff', k.staff_fill], ['Completed', k.done]]),
    c.busy && el('div', { class: 'warn', style: 'position:sticky;top:0;z-index:5' }, c.busy, ' ', c.sendingAll && el('button', { class: 'primary', onclick: () => { c.stop = true; c.busy = 'Stopping after the sites already in progress...'; render(); } }, 'Stop')),
    c.results && el('div', { class: 'warn' }, el('strong', {}, 'Results: '), c.results.summary,
      el('p', { class: 'muted' }, 'Open the results page for evidence and the next step for each attempt.'),
      el('button', { onclick: () => { c.results = null; render(); } }, 'Dismiss')),
    canWrite && el('section', { class: 'result-card' },
      el('h3', {}, 'Saved sending batches'),
      el('p', { class: 'muted' }, 'Keep this page open while sending. After closing it, resume untouched sites here. Interrupted attempts stay held for verification. Showing the latest 50 batches.'),
      c.batches?.error && el('p', { class: 'error' }, c.batches.error),
      btn('Refresh batch progress', reload),
      ...(c.batches?.entries || []).map(b => el('div', { class: 'result-card' },
        el('strong', {}, new Date(b.startedAt).toLocaleString() + (b.restoredOnly ? ' - Restored sites' : ' - Approved sites')),
        el('p', {}, b.finished + '/' + b.total + ' finished; ' + b.remaining + ' untouched; ' + b.confirmed + ' confirmed; ' + b.needsVerification + ' need verification; ' + b.notSent + ' not sent; ' + b.humanCheck + ' human check; ' + b.skipped + ' no longer eligible'),
        el('p', { class: 'muted' }, b.active ? 'Processing sites...' : b.remaining ? 'Ready to resume remaining sites.' : 'No untouched sites remain.'),
        el('button', { disabled: !b.remaining || b.active || !!c.sendingAll || !!c.checkingReadiness, onclick: () => sendAll({ resumeRunId: b.runId, restoredOnly: b.restoredOnly }) }, 'Resume remaining sites')))),
    readinessPanel(),
    preview(),
    el('div', { class: 'row' }, btn('Open results page', async () => { await reload(); state.tab = 'results'; render(); })),
    k && el('p', { class: 'muted' }, `Suggested ${k.proposed}, approved ${k.approved}, sent but not confirmed ${k.sent}, staff will fill ${k.staff_fill}, marked done ${k.done}, skipped ${k.skipped}. ${data.staffSitesVisible ? 'Staff-only sites are listed first.' : 'Sites that need staff are handled by an admin and are not shown here.'} "Marked done" is entered by a person; the software does not check it.`),
    canWrite && el('div', { class: 'row' },
      btn('Suggest sites (number chosen above; staff-only sites are extra)', async () => { try { const r = await api('/api/clients/' + id + '/sites/propose', 'POST', {}); c.notice = r.added ? `Added ${r.added} suggested sites.` : 'No new sites to add.'; c.offset = 0; await reload(); } catch (e) { c.notice = e.message; render(); } }),
      canWrite && el('div', {}, el('label', { for: 'send-par' }, 'Sites at once (1 to 12)'), el('input', { id: 'send-par', type: 'number', min: '1', max: '12', value: String(c.batchParallel || 10), style: 'width:6em', onchange: ev => { c.batchParallel = Math.min(12, Math.max(1, parseInt(ev.target.value, 10) || 10)); } })),
      canWrite && btn('Send all approved sites now (no preview)', sendAll),
      btn('Approve all suggested no-staff sites', async () => { if (!confirm('Approve every suggested site that does not need staff?')) return; const r = await api('/api/clients/' + id + '/sites/approve-all', 'POST', {}); c.notice = `Approved ${r.approved} sites.`; await reload(); })),
    c.notice && el('div', { class: 'warn' }, c.notice),
    el('div', { class: 'row', style: 'align-items:end' },
      el('div', {}, el('label', { for: 'cs-status' }, 'Show'), el('select', { id: 'cs-status', onchange: async () => { c.status = val('cs-status'); c.offset = 0; await reload(); } },
        el('option', { value: '' }, 'All'), el('option', { value: 'captcha', selected: c.status === 'captcha' }, 'CAPTCHA sites (finish by hand)'), el('option', { value: 'already', selected: c.status === 'already' }, 'Already a member / subscribed (verify)'), el('option', { value: 'likely', selected: c.status === 'likely' }, 'Very probably sent (verify)'), el('option', { value: 'approved_note', selected: c.status === 'approved_note' }, 'Not sent (red notes, to fix or retry)'), el('option', { value: 'restored', selected: c.status === 'restored' }, 'Restored sites (retry list)'), Object.entries(CS_LABEL).map(([k2, v]) => el('option', { value: k2, selected: c.status === k2 }, v)))),
      canWrite && btn('Move CAPTCHA sites out of Approved (by notes)', moveCaptcha),
      canWrite && btn('Look at approved sites for CAPTCHAs', scanCaptcha),
      canWrite && btn('Move "already a member" sites to their list', moveAlready),
      canWrite && el('span', {}, el('label', { for: 'scan-par' }, 'at once'), el('input', { id: 'scan-par', type: 'number', min: '1', max: '16', value: '8', style: 'width:60px' })),
      canWrite && btn('Removed sites (restore)', async () => {
        const d = state.dir; d.q = ''; d.category = ''; d.view = 'removed'; d.offset = 0; d.toolResult = 'These sites were removed. Press Restore on a row to put it back. Press the Clients tab to go back to the client.';
        try { await loadSites(); state.tab = 'directory'; state.notice = ''; } catch (e) { c.notice = 'Could not open the site directory: ' + e.message; }
        render();
      }),
      canWrite && c.status === 'captcha' && el('div', {}, el('label', { for: 'captcha-par' }, 'Windows at once'), el('input', { id: 'captcha-par', type: 'number', min: '1', max: '10', value: String(c.captchaPar ?? 5), style: 'width:70px', onchange: () => { c.captchaPar = parseInt(val('captcha-par'), 10) || 5; } })),
      canWrite && c.status === 'captcha' && btn('Open next windows to finish by hand', () => openCaptchaBatch()),
      c.status === 'restored' && el('p', { class: 'muted' }, 'This list includes restored sites in every status. Sending uses only Approved sites. Sent, completed, and staff-handled sites are excluded.'),
      canWrite && c.status === 'restored' && btn('Approve unsent restored sites', async () => {
        if (!confirm('Approve suggested or skipped restored sites for this client? Only restored sites that can be automated are included. Previously sent, completed, staff-handled, and uncertain attempts stay out. Nothing is sent by this approval step.')) return;
        try { const r = await api('/api/clients/' + id + '/sites/approve-restored', 'POST', {}); c.notice = r.approved + ' restored sites approved. Use Send approved restored sites only to start them.'; await reload(); }
        catch (e) { c.notice = e.message; render(); }
      }),
      canWrite && c.status === 'restored' && btn('Send approved restored sites only', () => sendAll({ restoredOnly: true })),
      canWrite && c.status === 'restored' && state.user.role === 'admin' && btn('Remove restored sites that still failed, for good', () => cleanFailed('remove', { restoredOnly: true })),
      canWrite && (c.status === 'approved_note' || c.status === 'approved') && btn('Move these to Skipped', () => cleanFailed('skip')),
      canWrite && (c.status === 'approved_note' || c.status === 'approved') && state.user.role === 'admin' && btn('Remove these from the directory', () => cleanFailed('remove'))),
    data ? el('table', {}, el('tr', {}, el('th', {}, 'Site'), el('th', {}, 'Handling'), el('th', {}, 'Status'), canWrite && el('th', {}, '')), rows) : null,
    data && el('div', { class: 'row' },
      el('button', { disabled: c.offset === 0, onclick: async () => { c.offset = Math.max(0, c.offset - CS_PAGE); await reload(); } }, 'Previous'),
      el('span', { class: 'muted' }, data.total ? `${c.offset + 1}-${Math.min(c.offset + CS_PAGE, data.total)} of ${data.total}` : 'None yet. Choose a number of sites above, save, then press "Suggest sites".'),
      el('button', { disabled: c.offset + CS_PAGE >= data.total, onclick: async () => { c.offset += CS_PAGE; await reload(); } }, 'Next')));
}
async function refresh() { state.clients = (await api('/api/clients')).clients; }
async function removeClient() {
  if (!confirm('Delete this client? They will no longer appear in the list.')) return;
  const id = state.detail.id;
  try {
    await api('/api/clients/' + id, 'DELETE');
    if (state.selected === id) {
      state.detail = null;
      state.selected = null;
      state.cs = null;
      state.logins = null;
    }
    await refresh();
  } catch (e) { state.notice = e.message; }
  render();
}
async function showActivity() {
  const { entries } = await api('/api/audit?clientId=' + state.detail.id);
  const box = document.getElementById('activity'); box.replaceChildren(el('h3', { style: 'margin-top:16px' }, 'Activity log'),
    el('table', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Action'), el('th', {}, 'By')),
      entries.map(e => el('tr', {}, el('td', {}, new Date(e.at).toLocaleString()), el('td', {}, e.action), el('td', {}, (e.userId ?? '').slice(0, 8))))));
}

async function boot() {
  const { needsSetup, setupTokenRequired } = await api('/api/status');
  state.setupTokenRequired = setupTokenRequired;
  if (needsSetup) { state.view = 'setup'; return render(); }
  try {
    state.user = (await api('/api/me')).user; state.view = 'main'; state.message = '';
    await refresh();
    if (state.user.role !== 'viewer') await loadHealth();
  } catch (e) { if (e.status !== 401) throw e; state.view = 'login'; }
  render();
}
boot().catch(e => { app.replaceChildren(el('main', {}, el('section', {}, el('p', { class: 'error' }, 'Could not load: ' + e.message + '. Make sure Docker Desktop is running, then in C:\\ucaas run npm.cmd run db:up and npm.cmd run dev. If the terminal reports missing tables, run npm.cmd run db:migrate.')))); });


// ---------- Site directory ----------
const CATEGORY_NAMES = { subscription: 'Subscriptions', rewards: 'Rewards', membership: 'Memberships', employment: 'Employment', other: 'Other' };
const VIEW_NAMES = { active: 'Active (staff sites first)', staff: 'Staff handles these', research: 'Need a new address', removed: 'Removed', all: 'All' };
const PAGE = 50;

async function loadSites() {
  const d = state.dir;
  const qs = new URLSearchParams({ view: d.view, limit: String(PAGE), offset: String(d.offset) });
  if (d.q) qs.set('q', d.q);
  if (d.category) qs.set('category', d.category);
  d.data = await api('/api/sites?' + qs);
}
const safeHref = u => (/^https?:\/\//i.test(u || '') ? u : null);

function directoryView() {
  const d = state.dir, data = d.data, canWrite = state.user.role === 'admin';
  const c = data?.counts;
  const search = async () => { d.q = val('dir-q').trim(); d.category = val('dir-cat'); d.view = val('dir-view'); d.offset = 0; await loadSites(); render(); };
  const page = async delta => { d.offset = Math.max(0, d.offset + delta); await loadSites(); render(); };
  const rows = (data?.sites ?? []).map(s => {
    const href = safeHref(s.url);
    return el('tr', {},
      el('td', {}, href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, s.name) : s.name, el('div', { class: 'muted' }, s.domain)),
      el('td', {}, CATEGORY_NAMES[s.category] ?? s.category),
      el('td', {}, badge(s.reliability?.label || 'Untested', s.reliability?.label === 'Needs attention' ? 'bad' : s.reliability?.confirmed ? 'good' : 'pending'),
        s.reliability?.attempts > 0 && el('div', { class: 'muted' }, 'Score ' + s.reliability.score + '/100 · ' + s.reliability.confirmed + ' confirmed · ' + s.reliability.siteIssues + ' site issues · ' + s.reliability.unconfirmed + ' unconfirmed'),
        s.reliability?.lastAttempt && el('div', { class: 'muted' }, 'Last attempt: ' + new Date(s.reliability.lastAttempt).toLocaleDateString())),
      el('td', {}, badge(s.removedAt ? 'Removed' : s.catalogState === 'research' ? 'Needs new address' : s.needsStaff ? 'Staff assistance' : s.handling === 'simple' ? 'Page checked' : s.handling === 'unknown' ? 'Needs review' : 'Not checked', s.removedAt ? 'bad' : s.handling === 'simple' && !s.needsStaff ? 'good' : 'pending'),
        (s.removedReason || s.handlingReason) && el('div', { class: 'site-note muted' }, s.removedAt ? s.removedReason : s.handlingReason)),
      canWrite && el('td', {}, s.removedAt
        ? [el('button', { onclick: async () => {
            const u = prompt('Paste the exact web address of the sign-up page for ' + s.name + ' (same website). The site is put back so you can try it from the client page (Show > Restored sites).', s.url || '');
            if (u === null || !u.trim()) return;
            try { await api('/api/sites/' + s.id + '/signup-page', 'POST', { url: u.trim() }); await api('/api/sites/' + s.id + '/restore', 'POST'); d.toolResult = 'Saved and restored: ' + s.name + '. Try it from a client page under Show > Restored sites.'; await loadSites(); }
            catch (e) { d.toolResult = 'Not saved: ' + e.message; }
            render();
          } }, 'Fix sign-up page + restore'), ' ',
          el('button', { onclick: async () => { await api('/api/sites/' + s.id + '/restore', 'POST'); await loadSites(); render(); } }, 'Restore'), ' ',
          el('button', { onclick: async () => { const w = prompt('Mark ' + s.name + ' as DO NOT WORK, so you know not to restore it. Optional short reason:', ''); if (w === null) return; try { await api('/api/sites/' + s.id + '/do-not-work', 'POST', { reason: w }); d.toolResult = s.name + ' is marked DO NOT WORK.'; await loadSites(); } catch (e) { d.toolResult = e.message; } render(); } }, 'Do not work')]
        : [el('button', { onclick: async () => {
            const u = prompt('Paste the exact web address of the sign-up page for ' + s.name + ' (it must be on the same website). The software will start there.', s.url || '');
            if (u === null || !u.trim()) return;
            try { await api('/api/sites/' + s.id + '/signup-page', 'POST', { url: u.trim() }); d.toolResult = 'Saved. The software will start at that page for ' + s.name + '.'; await loadSites(); }
            catch (e) { d.toolResult = 'Not saved: ' + e.message; }
            render();
          } }, 'Set sign-up page'), ' ',
          el('button', { onclick: async () => { const reason = prompt('Why remove this site? (it can be restored later)'); if (reason === null) return; const r = await api('/api/sites/' + s.id + '/remove', 'POST', { reason }); d.toolResult = r.replacedBy?.length ? 'Removed. Replaced with: ' + r.replacedBy.join(', ') : 'Removed. No similar replacement was waiting.'; await loadSites(); render(); } }, 'Remove')]));
  });
  const importErr = el('div', { class: 'error', role: 'alert' });
  return el('main', {}, el('section', {},
    el('div', { class: 'page-heading' }, el('span', { class: 'eyebrow' }, 'Site management'), el('h1', {}, 'Site directory'), el('p', { class: 'muted' }, 'Find, review, and maintain the sites available for your clients.')),
    c && metrics([['Active sites', c.active], ['Needs staff', c.staff], ['Not checked', c.unchecked], ['Needs new address', c.research], ['Removed', c.removed]]),
    c ? el('p', { class: 'muted' }, `${c.active} of ${data.capacity} slots used. ${c.staff} need staff. ${c.unchecked} not checked yet. ${c.research} need a new address. ${c.removed} removed. Waiting to fill slots: ${data.candidates.simple} (another ${data.candidates.staff} found need staff, so they are kept out).` +
      (Object.keys(c.byCategory).length ? ' Active by category: ' + Object.entries(c.byCategory).map(([k, v]) => `${CATEGORY_NAMES[k] ?? k} ${v}`).join(', ') + '.' : '')) : null,
    canWrite && el('div', {}, el('label', { for: 'dir-file' }, 'Add sites from a file (bookmarks .html, .csv or .txt). Sites already in the directory are never changed.'),
      el('input', { id: 'dir-file', type: 'file', accept: '.html,.htm,.csv,.txt', onchange: async ev => {
        importErr.textContent = ''; d.importResult = '';
        const f = ev.target.files[0]; if (!f) return;
        try {
          let content = await f.text();
          content = content.replace(/\sICON="[^"]*"/gi, '').replace(/\sICON_URI="[^"]*"/gi, '');
          const r = await api('/api/sites/import', 'POST', { filename: f.name, content });
          d.importResult = `Read ${r.rowsRead} rows. Added ${r.added} new sites. ${r.alreadyInDirectory} were already there. ${r.duplicatesInFile} were repeats of the same website in the file. ${r.unreadable} could not be read. ${r.markedManualOnly} look sensitive (credit, banking, insurance) and are marked for staff to do by hand. ${r.alreadyRemovedFromEarlierCheck} were already removed by your earlier link check. ${r.needNewAddress} need a new address.`;
          d.offset = 0; await loadSites(); render();
        } catch (e) { importErr.textContent = e.message; }
      } }), importErr, d.importResult && el('div', { class: 'warn' }, d.importResult)),
    canWrite && el('div', { class: 'row', style: 'align-items:end' },
      el('div', {}, el('label', { for: 'add-name' }, 'Add one website: name'), el('input', { id: 'add-name', type: 'text', placeholder: 'Example Rewards Club' })),
      el('div', {}, el('label', { for: 'add-url' }, 'Exact sign-up page address'), el('input', { id: 'add-url', type: 'text', placeholder: 'https://www.example.com/join', style: 'min-width:320px' })),
      el('button', { onclick: async () => {
        importErr.textContent = ''; d.importResult = '';
        const name = val('add-name').trim().replace(/"/g, ''), u = val('add-url').trim();
        if (!/^https?:\/\/[^\s,"]+$/i.test(u)) { importErr.textContent = 'Paste the full web address, starting with https://'; render(); return; }
        try {
          const r = await api('/api/sites/import', 'POST', { filename: 'one-site.csv', content: 'name,url\n"' + (name || u) + '",' + u + '\n' });
          d.importResult = r.added ? 'Added. Press "Check next 30" below so the software looks at it. It will start at the page you gave.' : 'That website is already in the directory (or was removed earlier). To change its sign-up page, find it in the list and press "Set sign-up page".';
          d.offset = 0; await loadSites();
        } catch (e) { importErr.textContent = e.message; }
        render();
      } }, 'Add website')),
    canWrite && toolsPanel(),
    d.toolResult && el('div', { class: 'warn' }, d.toolResult),
    el('div', { class: 'row', style: 'align-items:end' },
      el('div', {}, el('label', { for: 'dir-q' }, 'Search'), el('input', { id: 'dir-q', value: d.q, placeholder: 'name or website', onkeydown: ev => { if (ev.key === 'Enter') search(); } })),
      el('div', {}, el('label', { for: 'dir-cat' }, 'Category'), el('select', { id: 'dir-cat' }, el('option', { value: '' }, 'All'),
        Object.entries(CATEGORY_NAMES).map(([k, v]) => el('option', { value: k, selected: d.category === k }, v)))),
      el('div', {}, el('label', { for: 'dir-view' }, 'Show'), el('select', { id: 'dir-view' },
        Object.entries(VIEW_NAMES).map(([k, v]) => el('option', { value: k, selected: d.view === k }, v)))),
      el('button', { class: 'primary', onclick: search }, 'Search')),
    el('p', { class: 'muted' }, 'Reliability uses saved attempts from the last 90 days. Scores rank evidence, not the probability of success. Unconfirmed sends and missing client information do not lower the score. New suggestions prioritize higher scores; existing client lists stay as they are. Categories are keyword guesses.'),
    data ? el('table', {}, el('tr', {}, el('th', {}, 'Site'), el('th', {}, 'Category (guess)'), el('th', {}, 'Reliability'), el('th', {}, 'Handling'), canWrite && el('th', {}, '')), rows) : null,
    data && !data.sites.length ? el('p', { class: 'muted' }, 'Nothing here yet. Use "Add sites from a file" above.') : null,
    data ? el('div', { class: 'row' },
      el('button', { disabled: d.offset === 0, onclick: () => page(-PAGE) }, 'Previous'),
      el('span', { class: 'muted' }, `${Math.min(d.offset + 1, data.total)}-${Math.min(d.offset + PAGE, data.total)} of ${data.total}`),
      el('button', { disabled: d.offset + PAGE >= data.total, onclick: () => page(PAGE) }, 'Next')) : null));
}

async function loadDiscoveryHistory() {
  const h = state.discoveryHistory || (state.discoveryHistory = { offset: 0, data: null, error: '' });
  h.data = await api('/api/discovery/history?limit=20&offset=' + h.offset); h.error = '';
}
function discoveryHistoryPage() {
  const h = state.discoveryHistory;
  const reload = async () => { try { await loadDiscoveryHistory(); } catch (e) { h.error = e.message; } render(); };
  const labels = { running: 'Incomplete — no stop recorded', full: 'Directory full', stopped: 'Stopped by you', no_finds: 'No-find cutoff reached', error: 'Stopped on error', completed: 'Single batch completed' };
  return el('main', {}, el('div', { class: 'page-heading' }, el('span', { class: 'eyebrow' }, 'Saved research activity'), el('h1', {}, 'Discovery history'),
    el('p', { class: 'muted' }, 'Each run keeps its totals and reasons across restarts. Incomplete runs may still be active, or may have been interrupted; their totals cover completed, saved batches. Searches from a failed or interrupted batch may not be included. Earlier runs made before this feature remain in the activity log.')),
    el('button', { onclick: reload }, 'Refresh history'), h?.error && el('div', { class: 'error', role: 'alert' }, h.error),
    el('div', { class: 'result-list' }, (h?.data?.entries || []).map(run => el('article', { class: 'result-card' },
      el('div', { class: 'result-card-heading' }, el('h3', {}, run.ai ? 'AI discovery · United States' : 'Standard discovery · United States'), badge(labels[run.status] || 'Saved run', run.status === 'error' ? 'bad' : run.status === 'full' ? 'good' : 'pending')),
      el('p', { class: 'muted' }, 'Started: ' + new Date(run.startedAt || run.at).toLocaleString() + ' · Last saved: ' + new Date(run.at).toLocaleString()),
      metrics([['Searches', run.requests], ['Sites checked', run.totals?.looked], ['Qualified', run.totals?.simple], ['Added to directory', run.totals?.addedToDirectory]]),
      el('p', {}, run.batches + ' batches · ' + (run.totals?.unknown || 0) + ' held for review · ' + (run.totals?.unreachable || 0) + ' unreachable · ' + (run.totals?.excluded || 0) + ' excluded.'),
      el('p', { class: 'muted' }, run.active + '/' + run.capacity + ' directory slots used at the last checkpoint. ' + (run.noFindLimit ? 'No-find cutoff: ' + run.noFindLimit + ' consecutive empty batches.' : '')),
      run.note && el('p', {}, run.note),
      el('details', {}, el('summary', {}, 'Rejection reasons'), el('p', {}, why('Could not read', run.unreadable) || 'No access failures recorded.'), el('p', {}, why('Held for review', run.reviewReasons) || 'No review holds recorded.'))))),
    !h?.data?.entries?.length && el('p', { class: 'muted' }, 'No saved runs yet. Start discovery from the Site directory.'),
    el('div', { class: 'row' }, el('button', { disabled: !h?.offset, onclick: async () => { h.offset = Math.max(0, h.offset - 20); await reload(); } }, 'Newer runs'),
      el('span', { class: 'muted' }, (h?.data?.total ? h.offset + 1 : 0) + '–' + Math.min((h?.offset || 0) + 20, h?.data?.total || 0) + ' of ' + (h?.data?.total || 0)),
      el('button', { disabled: (h?.offset || 0) + 20 >= (h?.data?.total || 0), onclick: async () => { h.offset += 20; await reload(); } }, 'Older runs')));
}

async function loadDiscoveryReview() {
  const r = state.review || (state.review = { view: 'held', q: '', offset: 0, data: null, notice: '', busy: '' });
  const query = new URLSearchParams({ view: r.view, q: r.q, offset: String(r.offset), limit: '20' });
  r.data = await api('/api/discovery/review?' + query);
  if (r.offset && r.offset >= r.data.total) { r.offset = Math.max(0, Math.floor((r.data.total - 1) / 20) * 20); query.set('offset', String(r.offset)); r.data = await api('/api/discovery/review?' + query); }
}
function discoveryReviewPage() {
  const r = state.review;
  if (!r) return el('main', {}, el('p', {}, 'Open Discovery review to load candidates.'));
  const reload = async () => { try { await loadDiscoveryReview(); } catch (e) { r.notice = e.message; } render(); };
  r.selected = r.selected || {};
  const eligible = (r.data?.entries || []).filter(entry => entry.state === 'pending' && !/bot_blocked|robots_disallowed|automated.*block|blocked.*automated/i.test(entry.handlingReason));
  const eligibleIds = new Set(eligible.map(entry => entry.id));
  for (const id of Object.keys(r.selected)) if (!eligibleIds.has(id)) delete r.selected[id];
  const selected = eligible.filter(entry => r.selected[entry.id]);
  const bulkRecheck = async () => {
    if (r.busy || !selected.length) return;
    const queue = selected.slice();
    r.bulkRunning = true; r.bulkStop = false; r.busy = 'bulk';
    let done = 0, qualified = 0, promoted = 0, held = 0, failed = 0, stoppedForError = '';
    const errors = [];
    try {
      for (const entry of queue) {
        if (r.bulkStop) break;
        r.busy = entry.id;
        r.notice = 'Rechecking ' + (done + 1) + '/' + queue.length + ': ' + entry.domain + '. ' + qualified + ' qualified so far. Nothing will be submitted. Stop finishes after the current site.';
        render();
        try {
          const result = await api('/api/discovery/review/' + entry.id + '/recheck', 'POST', {});
          if (result.result?.simple) qualified++; else held++;
          if (result.candidate?.state === 'promoted') promoted++;
        } catch (e) {
          failed++; errors.push(entry.domain + ': ' + e.message);
          if (!e.status || [401, 403].includes(e.status) || e.status >= 500) stoppedForError = e.message;
        }
        done++; delete r.selected[entry.id];
        if (stoppedForError) break;
      }
    } finally {
      r.busy = ''; r.bulkRunning = false;
      r.notice = 'Rechecked ' + done + '/' + queue.length + ' selected sites: ' + qualified + ' qualified, ' + promoted + ' added to the directory, ' + held + ' still held or excluded, ' + failed + ' checks failed.'
        + (r.bulkStop ? ' Stopped by you after the current site.' : stoppedForError ? ' Stopped: ' + stoppedForError : '')
        + (errors.length ? ' Errors: ' + errors.slice(0, 3).join(' | ') : '');
      try { await loadDiscoveryReview(); } catch (e) { r.notice += ' Could not refresh the list: ' + e.message; }
      render();
    }
  };
  const action = async (entry, name) => {
    if (r.busy) return;
    let payload = {};
    if (name === 'signup-page') {
      const url = prompt('Paste the full signup page address for ' + entry.domain + '. Saving it does not submit a form.', entry.url || 'https://');
      if (url === null) return;
      payload = { url: url.trim() };
    }
    r.busy = entry.id; r.notice = name === 'recheck' ? 'Checking ' + entry.domain + ' in a browser and reviewing US/free eligibility. Nothing will be submitted.' : '';
    render();
    try {
      const result = await api('/api/discovery/review/' + entry.id + '/' + name, 'POST', payload);
      r.notice = name === 'signup-page' ? (result.unchanged ? 'The signup address is unchanged. ' : 'Signup page saved. ') + 'Use Recheck eligibility to check the saved page.' : name === 'dismiss' ? entry.domain + ' dismissed. You can restore it from Dismissed.' : name === 'restore' ? entry.domain + ' restored to its review list.'
        : result.candidate?.state === 'promoted' ? entry.domain + ' qualified and was added to the directory.'
        : result.result.simple ? entry.domain + ' qualified and is waiting for a directory slot.'
        : entry.domain + ': ' + (result.candidate?.handlingReason || 'Still needs review.');
      if (name === 'signup-page' && !result.unchanged) { r.view = 'held'; r.q = entry.domain; r.offset = 0; }
      await loadDiscoveryReview();
    } catch (e) { r.notice = e.message; }
    r.busy = ''; render();
  };
  return el('main', {},
    el('div', { class: 'page-heading' }, el('span', { class: 'eyebrow' }, 'Directory research'), el('h1', {}, 'Discovery review'),
      el('p', { class: 'muted' }, 'Inspect candidates before they qualify for the directory. Recheck reads public pages and reviews eligibility; it never fills or submits a form.')),
    el('div', { class: 'row' },
      el('div', {}, el('label', { for: 'review-view' }, 'Candidate list'), el('select', { id: 'review-view', disabled: !!r.busy, onchange: async ev => { r.view = ev.target.value; r.offset = 0; await reload(); } },
        [['held', 'Held for review'], ['blocked', 'Blocked sites — inspect manually'], ['staff', 'Needs staff'], ['qualified', 'Qualified — waiting for a slot'], ['dismissed', 'Dismissed']].map(([value, label]) => el('option', { value, selected: r.view === value }, label)))),
      el('div', {}, el('label', { for: 'review-query' }, 'Search name, domain, or reason'), el('input', { id: 'review-query', value: r.q, type: 'search' })),
      el('button', { disabled: !!r.busy, onclick: async () => { r.q = val('review-query').trim(); r.offset = 0; await reload(); } }, 'Search'),
      el('button', { disabled: !!r.busy, onclick: reload }, 'Refresh')),
    el('div', { class: 'row' },
      el('button', { disabled: !!r.busy || !eligible.length, onclick: () => { for (const entry of eligible) r.selected[entry.id] = true; render(); } }, 'Select eligible sites on this page'),
      el('button', { disabled: !!r.busy || !selected.length, onclick: () => { r.selected = {}; render(); } }, 'Clear selection'),
      el('button', { class: 'primary', disabled: !!r.busy || !selected.length, onclick: bulkRecheck }, 'Recheck selected (' + selected.length + ')'),
      r.bulkRunning && el('button', { disabled: r.bulkStop, onclick: () => { r.bulkStop = true; r.notice = 'Stopping after the current site finishes. No more selected sites will be started.'; render(); } }, r.bulkStop ? 'Stopping…' : 'Stop rechecks')),
    el('p', { class: 'muted' }, 'Select up to 20 candidates on the current page. Rechecks run one site at a time and may use AI credits. Blocked and dismissed sites cannot be selected.'),
    r.notice && el('div', { class: 'warn', role: 'status', 'aria-live': 'polite' }, r.notice),
    r.view === 'blocked' && el('p', { class: 'muted' }, 'Automatic rechecks are disabled for sites blocking automated access or disallowing it in robots.txt. Open them manually to inspect them.'),
    el('p', { class: 'muted' }, (r.data?.total || 0) + ' candidates in this list. Older static-only candidates need a fresh browser check. Blocked and unreachable URLs are retained from new discovery runs; earlier runs did not save those URLs.'),
    el('div', { class: 'result-list' }, (r.data?.entries || []).map(entry => {
      const href = safeHref(entry.url), blocked = /bot_blocked|robots_disallowed|automated.*block|blocked.*automated/i.test(entry.handlingReason);
      return el('article', { class: 'result-card' },
        eligibleIds.has(entry.id) && el('label', {}, el('input', { type: 'checkbox', checked: !!r.selected[entry.id], disabled: !!r.busy, onchange: ev => { if (ev.target.checked) r.selected[entry.id] = true; else delete r.selected[entry.id]; render(); } }), ' Select ' + entry.domain + ' for recheck'),
        el('div', { class: 'result-card-heading' }, el('div', {}, el('h3', {}, entry.name), el('p', { class: 'muted' }, entry.domain)), badge(entry.state === 'rejected' ? 'Dismissed' : blocked ? 'Manual inspection' : entry.handling === 'staff' ? 'Needs staff' : entry.handlingReason.startsWith('Browser verified signup: ') ? 'Qualified' : 'Held for review')),
        el('p', { class: 'muted', style: 'overflow-wrap:anywhere' }, 'Signup address: ', entry.url),
        el('p', {}, el('strong', {}, 'Reason: '), entry.handlingReason || 'No reason recorded.'),
        el('p', { class: 'muted' }, 'Source: ' + entry.source + ' · Category: ' + entry.category),
        el('div', { class: 'row' },
          href && el('a', { class: 'result-link', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open signup page'),
          entry.state !== 'rejected' && el('button', { disabled: !!r.busy, onclick: () => action(entry, 'signup-page') }, 'Edit signup page'),
          entry.state !== 'rejected' && !blocked && el('button', { disabled: !!r.busy, onclick: () => action(entry, 'recheck') }, r.busy === entry.id ? 'Checking…' : 'Recheck eligibility'),
          el('button', { disabled: !!r.busy, onclick: () => action(entry, entry.state === 'rejected' ? 'restore' : 'dismiss') }, entry.state === 'rejected' ? 'Restore candidate' : 'Dismiss candidate')));
    })),
    !r.data?.entries?.length && el('p', {}, 'No candidates match this list and search.'),
    el('div', { class: 'row' },
      el('button', { disabled: !!r.busy || !r.offset, onclick: async () => { r.offset = Math.max(0, r.offset - 20); await reload(); } }, 'Previous'),
      el('span', { class: 'muted' }, (r.data?.total ? r.offset + 1 : 0) + '–' + Math.min(r.offset + 20, r.data?.total || 0) + ' of ' + (r.data?.total || 0)),
      el('button', { disabled: !!r.busy || r.offset + 20 >= (r.data?.total || 0), onclick: async () => { r.offset += 20; await reload(); } }, 'Next')));
}

const why = (label, bag) => Object.keys(bag ?? {}).length ? ` ${label}: ` + Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} x ${k}`).join('; ') + '.' : '';

function toolsPanel() {
  const d = state.dir, err = el('div', { class: 'error', role: 'alert' }), progress = el('div', { class: 'muted', role: 'status', 'aria-live': 'polite' }, d.discoveryProgress || '');
  const run = (label, fn) => el('button', { onclick: async ev => {
    if (d.discoveryRunning) { err.textContent = 'Discovery is already running. Press Stop and wait for the current batch to finish.'; return; }
    const b = ev.target; err.textContent = ''; b.disabled = true; const old = b.textContent; b.textContent = 'Working...';
    try { d.toolResult = await fn(); await loadSites(); render(); } catch (e) { err.textContent = e.message; b.disabled = false; b.textContent = old; }
  } }, label);
  const searchUntilFull = async ai => {
    const noFindLimit = Math.min(100, Math.max(1, parseInt(val('discovery-empty-limit'), 10) || 4));
    d.discoveryEmptyLimit = noFindLimit;
    d.discoveryRunning = true; d.stop = false;
    let batches = 0, requests = 0, empty = 0, active = 0, capacity = 0, note = '';
    const totals = { looked: 0, simple: 0, unknown: 0, staff: 0, excluded: 0, unreachable: 0, addedToDirectory: 0, filteredSearchHits: 0 };
    const unreadable = {}, reviewReasons = {};
    const runId = crypto.randomUUID(), startedAt = new Date().toISOString();
    let runStatus = 'running';
    const checkpoint = () => api('/api/discovery/history', 'POST', { runId, startedAt, ai, status: runStatus, batches, requests, active, capacity, noFindLimit, empty, totals, unreadable, reviewReasons, note });
    const update = text => { d.discoveryProgress = text; progress.textContent = text; };
    try {
      await checkpoint();
      // Check available slots before making paid search or AI calls.
      const current = await api('/api/sites?limit=1&offset=0');
      active = current.counts.active; capacity = current.capacity;
      if (active >= capacity) { runStatus = 'full'; note = 'The directory is already full. No searches were run.'; }
      while (!d.stop && active < capacity) {
        update((ai ? 'AI discovery' : 'Discovery') + ': batch ' + (batches + 1) + ' in progress. ' + totals.addedToDirectory + ' sites added; ' + active + '/' + capacity + ' slots used. Press Stop to finish after this batch.');
        let r;
        try { r = await api('/api/discovery/search', 'POST', { ai, runId }); }
        catch (e) { runStatus = 'error'; note = 'Stopped: ' + e.message; break; }
        batches++; requests += r.searchRequests || 6;
        for (const key of Object.keys(totals)) totals[key] += r[key] || 0;
        for (const [key, n] of Object.entries(r.unreadable || {})) unreadable[key] = (unreadable[key] || 0) + n;
        for (const [key, n] of Object.entries(r.reviewReasons || {})) reviewReasons[key] = (reviewReasons[key] || 0) + n;
        active = r.active; capacity = r.capacity;
        empty = (r.simple || r.addedToDirectory) ? 0 : empty + 1;
        update(batches + ' batches, ' + requests + ' searches: ' + totals.simple + ' qualified, ' + totals.addedToDirectory + ' added; ' + active + '/' + capacity + ' slots used. ' + empty + '/' + noFindLimit + ' consecutive batches without a qualifying find.');
        await checkpoint();
        if (active >= capacity) { runStatus = 'full'; note = 'The directory is full.'; break; }
        if (empty >= noFindLimit) { runStatus = 'no_finds'; note = 'Stopped after ' + empty + ' consecutive batches found no qualifying sites. Each batch runs up to 6 searches.'; break; }
      }
      if (d.stop) { runStatus = 'stopped'; note = 'Stopped by you after the current batch.'; }
      await checkpoint();
      return (ai ? 'AI discovery: ' : 'Discovery: ') + batches + ' batches (' + requests + ' searches). Checked ' + totals.looked + ' new sites: ' + totals.simple + ' qualified, ' + totals.unknown + ' held for review, ' + totals.unreachable + ' unreachable. Added ' + totals.addedToDirectory + ' sites. ' + active + '/' + capacity + ' slots used. ' + note + why('Could not read', unreadable) + why('Held for review', reviewReasons);
    } catch (e) { runStatus = 'error'; note = 'Stopped: ' + e.message; try { await checkpoint(); } catch { /* history service unavailable */ } throw e; }
    finally { d.discoveryRunning = false; d.discoveryProgress = ''; progress.textContent = ''; }
  };
  return el('details', { class: 'tools-panel' }, el('summary', {}, 'Directory maintenance & discovery'),
    el('div', {}, el('label', { for: 'discovery-empty-limit' }, 'Stop after this many consecutive batches find no qualifying sites'),
      el('input', { id: 'discovery-empty-limit', type: 'number', min: '1', max: '100', value: String(d.discoveryEmptyLimit || 4), style: 'width:6em', onchange: ev => { d.discoveryEmptyLimit = Math.min(100, Math.max(1, parseInt(ev.target.value, 10) || 4)); } }),
      el('p', { class: 'muted' }, 'Default: 4 empty batches, about 24 searches. A qualifying find resets the count. Stop takes effect after the current batch. Keep B3T Ai and this browser tab open while searching.')),
    el('div', { class: 'row', style: 'align-items:end' }, el('div', {}, el('label', { for: 'sweep-par' }, 'Sites at once for the browser sweep (1 to 16)'), el('input', { id: 'sweep-par', type: 'number', min: '1', max: '16', value: '12', style: 'width:6em' }))),
    el('div', { class: 'row' },
      run('Check the next 30 sites', async () => {
        const r = await api('/api/discovery/check', 'POST', { limit: 30 });
        if (r.networkProblem) return 'Most of these sites could not be reached, which usually means your internet is down. Nothing was changed. Try again later.';
        return `Checked ${r.checked}: ${r.simple} need no staff, ${r.staff} need staff, ${r.unknown} unclear. ${r.excluded} dropped because they need a payment or file upload. ${r.removed} removed in all (${r.replacements.length} replaced), ${r.needNewAddress} need a new address. ${r.skipped} could not be read this time. ${r.remaining} still to check.` +
          why('Why', r.reasons) + why('Could not read', r.unreadable);
      }),
      run('Check ALL remaining sites', async () => {
        d.stop = false;
        const t = { checked: 0, simple: 0, staff: 0, unknown: 0, excluded: 0, removed: 0, replaced: 0, skipped: 0 }, reasons = {}, unread = {};
        let note = '', last = null;
        for (let i = 0; i < 40 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: 30 });
          if (r.networkProblem) { note = ' Stopped: most sites could not be reached, so your internet may be down. Nothing from that batch was changed.'; break; }
          last = r;
          for (const k of Object.keys(t)) t[k] += k === 'replaced' ? r.replacements.length : (r[k] ?? 0);
          for (const [k, n] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + n;
          for (const [k, n] of Object.entries(r.unreadable)) unread[k] = (unread[k] ?? 0) + n;
          progress.textContent = `Checked ${t.checked} so far. ${r.remaining} left. Press Stop to pause.`;
          if (r.remaining === 0 || r.checked === 0) break;
        }
        if (d.stop) note = ' Stopped by you.';
        progress.textContent = '';
        return `Checked ${t.checked}: ${t.simple} need no staff, ${t.staff} need staff, ${t.unknown} unclear. ${t.excluded} dropped (payment or file upload), ${t.removed} removed in all (${t.replaced} replaced). ${t.skipped} could not be read. ${last?.remaining ?? 0} still unchecked (some may never be readable).` + why('Why', reasons) + why('Could not read', unread) + note;
      }),
      el('button', { onclick: () => { d.stop = true; } }, 'Stop'),
      run('Check unclear and blocked sites in a browser', async () => {
        d.stop = false;
        const t = { checked: 0, simple: 0, staff: 0, unknown: 0, excluded: 0, removed: 0, skipped: 0 }, reasons = {}, unread = {};
        let note = '';
        for (let i = 0; i < 40 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: 10, browser: true });
          if (r.networkProblem) { note = ' Stopped: most sites could not be reached, so your internet may be down.'; break; }
          for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
          for (const [k, n] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + n;
          for (const [k, n] of Object.entries(r.unreadable)) unread[k] = (unread[k] ?? 0) + n;
          progress.textContent = `Looked at ${t.checked + t.skipped} sites in a browser so far. Press Stop to pause.`;
          if (r.checked + r.skipped === 0) break;
        }
        if (d.stop) note = ' Stopped by you.';
        progress.textContent = '';
        return `Browser check of ${t.checked + t.skipped} sites: ${t.simple} now need no staff, ${t.staff} need staff, ${t.unknown} still unclear. ${t.excluded} dropped (payment or file upload), ${t.removed} removed in all. ${t.skipped} could not be read.` + why('Why', reasons) + why('Could not read', unread) + note;
      }),
      run('Remove sites with no sign-up form', async () => {
        if (!confirm('This opens every working site in a browser (it only looks, never types or clicks) and REMOVES the ones that have no sign-up form, such as articles or pages with only a search box or comment form. It can take a few hours; you can press Stop and continue later. Removed sites can be restored from Show > Removed. Continue?')) return 'Cancelled. Nothing was changed.';
        d.stop = false;
        const par = Math.min(16, Math.max(1, parseInt(val('sweep-par'), 10) || 12));
        const t = { checked: 0, simple: 0, staff: 0, unknown: 0, removed: 0, excluded: 0, skipped: 0 }, reasons = {}, unread = {};
        let note = '', replaced = 0;
        for (let i = 0; i < 400 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: Math.max(10, par * 2), forms: true, parallel: par });
          if (r.networkProblem) { note = ' Stopped: most sites could not be reached, so your internet may be down.'; break; }
          for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
          replaced += r.replacements.length;
          for (const [k, n] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + n;
          for (const [k, n] of Object.entries(r.unreadable)) unread[k] = (unread[k] ?? 0) + n;
          progress.textContent = `Looked at ${t.checked + t.skipped} sites so far, ${t.removed} removed. Press Stop to pause.`;
          if (r.checked + r.skipped === 0) break;
        }
        if (d.stop) note = ' Stopped by you. Press the button again to continue where it left off.';
        progress.textContent = '';
        return `Looked at ${t.checked + t.skipped} sites in a browser: ${t.removed} removed because no sign-up form was found (${replaced} replaced by new sites, which are checked the next time). ${t.simple} have a sign-up form, ${t.staff} need staff. ${t.skipped} could not be read and were kept.` + why('Why', reasons) + why('Could not read', unread) + note;
      }),
      run('Re-check CAPTCHA sites in a browser', async () => {
        d.stop = false;
        const t = { checked: 0, simple: 0, staff: 0, unknown: 0, skipped: 0 };
        let note = '';
        for (let i = 0; i < 80 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: 20, captcha: true, parallel: 4 });
          if (r.networkProblem) { note = ' Stopped: most sites could not be reached, so your internet may be down.'; break; }
          for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
          progress.textContent = `Looked at ${t.checked + t.skipped} CAPTCHA sites so far: ${t.simple} turned out to have no CAPTCHA. Press Stop to pause.`;
          if (r.checked + r.skipped === 0) break;
        }
        if (d.stop) note = ' Stopped by you.';
        progress.textContent = '';
        return `Looked again, in a real browser, at sites marked as CAPTCHA sites: ${t.simple} have no visible CAPTCHA and now need no staff, ${t.staff} still need staff, ${t.unknown} unclear. ${t.skipped} could not be read and were left as they were.` + note;
      }),
      run('Re-check removed "no form" sites', async () => {
        d.stop = false;
        const t = { looked: 0, restored: 0, noRoom: 0, stillNoForm: 0, skipped: 0 };
        let note = '';
        for (let i = 0; i < 100 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: 20, removed: true, parallel: 4 });
          for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
          progress.textContent = `Looked at ${t.looked} removed sites so far: ${t.restored} put back. Press Stop to pause.`;
          if (r.looked === 0) break;
        }
        if (d.stop) note = ' Stopped by you. Press the button again to continue.';
        progress.textContent = '';
        return `Looked again at ${t.looked} removed sites in a browser: ${t.restored} have a sign-up form after all and were put back. ${t.noRoom} have one too but there is no free slot (they stay in Removed; restore them when you free slots). ${t.stillNoForm} really have no form. ${t.skipped} could not be read.` + note;
      }),
      run('Re-check working sites', async () => {
        d.stop = false;
        const t = { checked: 0, simple: 0, staff: 0, excluded: 0, removed: 0, needNewAddress: 0, skipped: 0 }, reasons = {}, unread = {};
        let note = '', replaced = 0;
        for (let i = 0; i < 100 && !d.stop; i++) {
          const r = await api('/api/discovery/check', 'POST', { limit: 30, health: true });
          if (r.networkProblem) { note = ' Stopped: most sites could not be reached, so your internet may be down.'; break; }
          for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
          replaced += r.replacements.length;
          for (const [k, n] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + n;
          for (const [k, n] of Object.entries(r.unreadable)) unread[k] = (unread[k] ?? 0) + n;
          progress.textContent = `Re-checked ${t.checked + t.skipped} sites so far. Press Stop to pause.`;
          if (r.checked + r.skipped === 0) break;
        }
        if (d.stop) note = ' Stopped by you.';
        progress.textContent = '';
        if (t.checked + t.skipped === 0) return 'Nothing is due. Sites checked in the last 6 hours are skipped; try again later.';
        return `Re-checked ${t.checked + t.skipped} working sites: ${t.simple} still fine, ${t.staff} now need staff, ${t.removed} removed (${replaced} replaced), ${t.needNewAddress} need a new address. ${t.skipped} could not be read this time.` + why('Why', reasons) + why('Could not read', unread) + note;
      }),
      run('Search until full', () => searchUntilFull(false)),
      run('Remove unclear sites', async () => {
        if (!window.confirm('Remove every site where even a browser found no sign-up form? You can restore any of them from Show > Removed.')) return 'Nothing removed.';
        const r = await api('/api/discovery/remove-unclear', 'POST');
        return `Removed ${r.removed} unclear sites. ${r.replaced} replaced by similar sites. Restore any from Show > Removed.`;
      }),
      run('Fill empty slots', async () => { const r = await api('/api/directory/refill', 'POST'); return `Added ${r.added}. ${r.active} of ${r.capacity} slots used. ${r.waitingCandidates} more candidates waiting.`; }),
      el('p', { class: 'muted' }, 'Discovery targets free consumer signups in the United States. Each search checks up to 12 new websites in a browser before qualifying them. AI mode also checks the page text for free signup and US eligibility. Uncertain candidates stay out of automatic promotion. Older candidates that only passed a static check stay in review.'),
      el('p', { class: 'muted' }, 'AI discovery: ' + (d.data?.aiDiscoveryReady ? 'configured' : 'needs LLM_PROVIDER=openai and LLM_API_KEY in .env') + '. Search: ' + (d.data?.searchReady ? 'configured' : 'needs Brave Search API settings') + '. Each AI batch uses up to 6 search requests and 13 AI requests. Continuous search repeats batches until full, stopped, or the no-find cutoff is reached; provider charges apply.'),
      run('AI search until full: free US signups', () => searchUntilFull(true)),
      run('Search for new sites', async () => { const r = await api('/api/discovery/search', 'POST'); return `Search found ${r.found} addresses. Looked at ${r.looked} new ones: ${r.simple} like your working sites, ${r.staff} need staff, ${r.unknown} unclear, ${r.unreachable} unreachable, ${r.excluded} skipped (payment or file upload), ${r.alreadyKnown} already in your directory. ${r.addedToDirectory} added to the directory.` + why('Unreachable because', r.unreadable); })),
    progress,
    el('label', { for: 'dir-paste' }, 'Or paste website addresses to look at (one per line, up to 200)'),
    el('textarea', { id: 'dir-paste', rows: '3' }),
    el('div', { class: 'row' }, run('Look at these sites', async () => {
      const urls = val('dir-paste').split(/\s+/).filter(Boolean);
      const r = await api('/api/discovery/candidates', 'POST', { urls });
      return `Looked at ${r.looked}: ${r.simple} like your working sites, ${r.staff} need staff, ${r.unknown} unclear, ${r.unreachable} unreachable, ${r.excluded} skipped (payment or file upload), ${r.alreadyKnown} already known, ${r.invalid} not web addresses. ${r.addedToDirectory} added to the directory.`;
    })), err);
}
