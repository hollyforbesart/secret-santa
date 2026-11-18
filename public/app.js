/* Family Secret Santa — front end (no framework, no build step). */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const tabsEl = document.getElementById('tabs');
  const toastEl = document.getElementById('toast');
  const TZ = 'America/Port_of_Spain';
  const COLORS = ['#c8102e', '#17693a', '#c99a2e', '#1d1a17', '#9e0b23', '#0f4f2a', '#b5651d'];

  let S = null; // latest /api/state

  // ------------------------------------------------------------ utilities
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstName = (n) => String(n || '').split(' ')[0];
  const colorFor = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const avatar = (name) => `<span class="avatar" style="background:${colorFor(name)}" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const fmtDate = (iso, opts = {}) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', ...opts }) : '';
  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '';
  function fmtWhen(iso) {
    const d = new Date(iso), now = new Date();
    const day = (x) => x.toLocaleDateString('en-US', { timeZone: TZ });
    if (day(d) === day(now)) return `Today ${fmtTime(iso)}`;
    const y = new Date(now.getTime() - 86400000);
    if (day(d) === day(y)) return `Yesterday ${fmtTime(iso)}`;
    return `${d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}, ${fmtTime(iso)}`;
  }
  const linkify = (text) => esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  // Trinidad is UTC-4 all year (no daylight saving), so this is exact.
  const toLocalInput = (iso) => iso ? new Date(new Date(iso).getTime() - 4 * 3600000).toISOString().slice(0, 16) : '';
  const fromLocalInput = (v) => v ? new Date(`${v}:00-04:00`).toISOString() : '';

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
    return data;
  }
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 3500);
  }
  const showError = (form, msg) => {
    let box = form.querySelector('.error');
    if (!box) { box = document.createElement('div'); box.className = 'error'; box.setAttribute('role', 'alert'); form.prepend(box); }
    box.textContent = msg; box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  async function busy(btn, fn) {
    const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'One moment…';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
  }
  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
  async function refresh() { S = await api('/api/state'); return S; }
  const siteUrl = () => location.origin + '/';
  function whatsappInvite() {
    const st = S.settings;
    const lines = [
      `🎅🎄 ${st.title}!`,
      '',
      "We're doing Secret Santa as a family. Tap the link to say if you're in (it takes 1 minute, no account needed):",
      siteUrl(),
    ];
    if (st.rsvp_deadline) lines.push('', `Please RSVP by ${fmtDate(st.rsvp_deadline)}.`);
    if (st.budget) lines.push(`Gift budget: ${st.budget}`);
    return `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
  }

  // ------------------------------------------------------------ push notifications
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const inAppBrowser = () => /FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(navigator.userAgent);
  let swReg = null;
  async function getReg() {
    if (!('serviceWorker' in navigator)) return null;
    if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js');
    return swReg;
  }
  async function pushStatus() {
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try { const reg = await getReg(); const sub = await reg.pushManager.getSubscription(); return sub ? 'on' : 'off'; } catch { return 'off'; }
  }
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function enablePush() {
    const reg = await getReg();
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. You can turn them on later in your phone settings.');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.vapidPublicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await api('/api/push/test', { method: 'POST' });
  }
  async function disablePush() {
    const reg = await getReg();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  }
  async function notifCard() {
    const status = await pushStatus();
    let inner;
    if (status === 'on') {
      inner = `<p>✅ <strong>Notifications are on</strong> on this phone.</p><button class="link-btn" data-act="push-off">Turn off</button>`;
    } else if (isIOS() && !isStandalone()) {
      inner = `<p><strong>Want a ping when the names are drawn or you get a message?</strong></p>
        <p>On iPhone, first add this site to your Home Screen:</p>
        <ol class="steps"><li>Open this page in <strong>Safari</strong>${inAppBrowser() ? ' (tap ⋯ then "Open in Safari")' : ''}</li><li>Tap the <strong>Share</strong> button <span aria-hidden="true">⬆️</span></li><li>Tap <strong>"Add to Home Screen"</strong></li><li>Open Secret Santa from your Home Screen and sign in, then tap "Turn on notifications"</li></ol>`;
    } else if (status === 'unsupported') {
      inner = `<p>This browser can't do notifications. ${inAppBrowser() ? 'Try opening the link in Chrome or Safari instead of inside WhatsApp.' : ''}</p>`;
    } else if (status === 'denied') {
      inner = `<p>Notifications are blocked for this site. You can allow them in your browser or phone settings.</p>`;
    } else {
      inner = `<p><strong>Get a ping on your phone</strong> when names are drawn or you get a message.</p><button class="btn" data-act="push-on">🔔 Turn on notifications</button>`;
    }
    return `<div class="card" id="notif-card"><h3>🔔 Notifications</h3>${inner}</div>`;
  }
  function wireNotif(root) {
    root.querySelector('[data-act=push-on]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await enablePush(); toast('Notifications are on! 🎉'); render(); } catch (err) { toast(err.message); }
    }));
    root.querySelector('[data-act=push-off]')?.addEventListener('click', async () => { await disablePush(); toast('Notifications turned off.'); render(); });
  }

  // ------------------------------------------------------------ shared pieces
  function hero(sub) {
    return `<div class="hero"><img src="/santa.jpg" alt="Santa relaxing on a Trinidad beach in sunglasses, pointing at you">
      <div class="hero-text"><div class="kicker">${esc(sub || "You're invited!")}</div><h1>${esc(S.settings.title)}</h1></div></div>
      <div class="flag-strip" aria-hidden="true"></div>`;
  }
  function infoCards() {
    const st = S.settings;
    const items = [];
    if (st.rsvp_deadline && S.phase === 'rsvp') items.push(['📅', 'RSVP by', fmtDate(st.rsvp_deadline), '']);
    if (st.draw_at && S.phase !== 'drawn') items.push(['🎁', 'Names drawn on', fmtDate(st.draw_at), `at ${fmtTime(st.draw_at)} — automatically!`]);
    if (S.phase === 'drawn') items.push(['🎁', 'Names drawn', 'Done! ✅', 'Sign in and spin to see who you got']);
    if (st.budget) items.push(['💰', 'Gift budget', st.budget, st.budget_note]);
    if (st.exchange_note) items.push(['🎄', 'Gift exchange', st.exchange_note, '']);
    return `<div class="info-grid">${items.map(([i, l, v, s]) => `<div class="info"><div class="icon" aria-hidden="true">${i}</div><div><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div>${s ? `<div class="sub">${esc(s)}</div>` : ''}</div></div>`).join('')}</div>`;
  }
  function whoIsIn() {
    if (!S.participants.length) return '';
    return `<div class="card"><h3>🎉 ${S.participants.length} ${S.participants.length === 1 ? 'person is' : 'people are'} in so far</h3><div class="chips">${S.participants.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div></div>`;
  }
  function setTabs(active) {
    const me = S && S.me;
    if (!me) { tabsEl.hidden = true; return; }
    const msgs = me.unreadGiftee + me.unreadSanta;
    const tab = (hash, icon, label, badge) => `<a href="#${hash}" class="${active === hash ? 'active' : ''}"><span class="ti" aria-hidden="true">${icon}</span>${label}${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
    tabsEl.innerHTML = tab('home', '🏠', 'Home') + tab('mylist', '📝', 'My List') + tab('messages', '✉️', 'Messages', msgs) + tab('wall', '💬', 'Family Chat', me.wallNew);
    tabsEl.hidden = false;
  }
  const backLink = (hash = 'home', label = 'Back') => `<a class="back" href="#${hash}">← ${label}</a>`;

  // ------------------------------------------------------------ views: signed out
  function viewLanding() {
    setTabs(null);
    const st = S.settings;
    let actions;
    if (S.rsvpOpen) {
      actions = `<div class="card"><h2>Are you joining in?</h2>
        <a class="btn big" href="#join">🎁 Yes, I'm in!</a>
        <a class="btn white" href="#decline">No thanks this year</a>
        ${S.participants.length ? `<p class="center small-text muted" style="margin:6px 0 0">Already said yes? <a href="#signin">Sign in here</a></p>` : ''}</div>`;
    } else {
      actions = `<div class="card"><h2>${S.phase === 'drawn' ? 'Names have been drawn! 🎉' : 'RSVPs are closed'}</h2>
        <p>${S.phase === 'drawn' ? 'Sign in to spin the wheel and see who you got.' : "Names will be drawn soon. If you're in, you can sign in to add your wish list."}</p>
        <a class="btn big red" href="#signin">👋 Sign in</a>
        <p class="small-text muted">Missed the RSVP? Message the organizer.</p></div>`;
    }
    app.innerHTML = `${hero()}
      ${st.welcome ? `<p style="font-size:1.15rem">${esc(st.welcome)}</p>` : ''}
      ${infoCards()}${actions}
      <div class="card"><h3>How it works</h3><ol class="steps">
        <li><strong>Say yes</strong> and pick a 4-number PIN (no account, no email needed).</li>
        <li><strong>Add your wish list</strong> so your Secret Santa knows what you'd like.</li>
        <li><strong>On draw day</strong>, names are picked automatically. You spin the wheel to see who you got!</li>
        <li><strong>Send secret messages</strong> to ask your person what they'd like — they won't know it's you.</li></ol></div>
      ${whoIsIn()}`;
  }

  function viewJoin() {
    setTabs(null);
    if (!S.rsvpOpen) return go('');
    app.innerHTML = `<div class="page-head">${backLink('', 'Back')}<h1>🎁 Wonderful!</h1><p>Just two quick things and you're in.</p></div>
      <form class="card" id="join-form" novalidate>
        <label for="name">Your name<span class="hint">First name is fine. Add a last name if there are two of you with the same name.</span></label>
        <input id="name" type="text" autocomplete="name" autocapitalize="words" maxlength="40" required>
        <label for="pin">Pick a 4-number PIN<span class="hint">Something easy to remember, like a birth year. You'll use it to sign in on a new phone.</span></label>
        <input id="pin" class="pin-input" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" required>
        <label for="pin2">Type the PIN again</label>
        <input id="pin2" class="pin-input" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" required>
        <div class="card notice" style="padding:12px 16px;margin-top:-4px;box-shadow:none">🧠 <strong>Make sure you remember it!</strong> Write it down or save it in your phone if you need to. 😄</div>
        ${S.emailEnabled ? `<label for="email">Email (optional)<span class="hint">Only if you'd like an email when names are drawn or you get a message.</span></label>
        <input id="email" type="email" autocomplete="email" inputmode="email">` : ''}
        <button class="btn big red" type="submit">Count me in! 🎄</button>
      </form>`;
    const f = document.getElementById('join-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = f.elements.namedItem('name').value.trim(), pin = f.pin.value.trim(), pin2 = f.pin2.value.trim();
      if (name.length < 2) return showError(f, 'Please type your name.');
      if (!/^\d{4}$/.test(pin)) return showError(f, 'Your PIN needs to be exactly 4 numbers.');
      if (pin !== pin2) return showError(f, "The two PINs don't match. Please type them again.");
      busy(f.querySelector('[type=submit]'), async () => {
        try {
          await api('/api/rsvp', { method: 'POST', body: { name, pin, answer: 'yes', email: f.email ? f.email.value.trim() : '' } });
          await refresh();
          go('#welcome');
        } catch (err) { showError(f, err.message); }
      });
    });
  }

  function viewDecline() {
    setTabs(null);
    app.innerHTML = `<div class="page-head">${backLink('', 'Back')}<h1>No worries at all!</h1><p>Just tell us your name so we know you've seen the invite.</p></div>
      <form class="card" id="no-form" novalidate>
        <label for="name">Your name</label>
        <input id="name" type="text" autocomplete="name" autocapitalize="words" maxlength="40" required>
        <button class="btn" type="submit">Send my answer</button>
      </form>`;
    const f = document.getElementById('no-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('[type=submit]'), async () => {
        try {
          await api('/api/rsvp', { method: 'POST', body: { name: f.elements.namedItem('name').value.trim(), answer: 'no' } });
          app.innerHTML = `<div class="page-head"><h1>Thanks for letting us know! 💚</h1><p>Have a wonderful Christmas. If you change your mind before the draw, just open this link again and tap "Yes, I'm in!"</p><a class="btn white" href="#">Back to the start</a></div>`;
        } catch (err) { showError(f, err.message); }
      });
    });
  }

  async function viewSignin(idPart) {
    setTabs(null);
    const { people } = await api('/api/people');
    const person = idPart && people.find((p) => String(p.id) === idPart);
    if (!person) {
      app.innerHTML = `<div class="page-head">${backLink('', 'Back')}<h1>👋 Who are you?</h1><p>Tap your name.</p></div>
        <div class="name-list">${people.map((p) => `<button class="name-btn" data-id="${p.id}">${avatar(p.name)}${esc(p.name)}</button>`).join('') || '<p>Nobody has said yes yet.</p>'}</div>
        ${S.rsvpOpen ? `<p class="center">Not on the list? <a href="#join">Say yes here</a></p>` : ''}`;
      app.querySelectorAll('.name-btn').forEach((b) => b.addEventListener('click', () => go(`#signin/${b.dataset.id}`)));
      return;
    }
    app.innerHTML = `<div class="page-head">${backLink('signin', 'Not you?')}<h1>Hi ${esc(firstName(person.name))}! 👋</h1><p>Type your 4-number PIN.</p></div>
      <form class="card" id="pin-form" novalidate>
        <label for="pin">Your PIN</label>
        <input id="pin" class="pin-input" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" autofocus required>
        <button class="btn big" type="submit">Sign in</button>
        <p class="small-text muted">Forgot your PIN? Message ${esc(S.settings.organizer_name || 'the organizer')} on WhatsApp and they'll reset it for you.</p>
      </form>`;
    const f = document.getElementById('pin-form');
    const submit = () => busy(f.querySelector('[type=submit]'), async () => {
      try { await api('/api/login', { method: 'POST', body: { id: person.id, pin: f.pin.value.trim() } }); await refresh(); go('#home'); }
      catch (err) { showError(f, err.message); f.pin.value = ''; f.pin.focus(); }
    });
    f.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    f.pin.addEventListener('input', () => { if (/^\d{4}$/.test(f.pin.value)) submit(); });
  }

  // ------------------------------------------------------------ views: signed in
  async function viewWelcome() {
    setTabs('home');
    const me = S.me;
    app.innerHTML = `<div class="page-head center"><div style="font-size:4rem" aria-hidden="true">🎉</div><h1>You're in, ${esc(firstName(me.name))}!</h1>
      <p>This phone will remember you, so next time just open the link.</p></div>
      <div class="card notice">🧠 <strong>Don't forget your PIN!</strong> You'll need it if you sign in on a different phone. Write it down somewhere safe. 😄</div>
      <div class="card"><h3>📝 Next: add your wish list</h3><p>Help your Secret Santa pick something you'll love.</p><a class="btn" href="#mylist">Add my wish list</a></div>
      <div class="card"><h3>👨‍👩‍👧 Know someone who should join?</h3><p>Send them the link on WhatsApp.</p><a class="btn whatsapp" href="${whatsappInvite()}" target="_blank" rel="noopener">Share on WhatsApp</a></div>
      ${await notifCard()}
      <a class="btn white" href="#home">Go to my page →</a>`;
    wireNotif(app);
  }

  async function viewHome() {
    setTabs('home');
    const me = S.me, st = S.settings;
    let main;
    if (S.phase !== 'drawn' || !me.hasMatch) {
      const when = st.draw_at ? `on <strong>${esc(fmtDateTime(st.draw_at))}</strong>` : 'soon';
      main = S.phase === 'drawn'
        ? `<div class="card green"><h2>⏳ Almost there</h2><p>Names have been drawn, and you're being added in. Check back shortly!</p></div>`
        : `<div class="card green"><h2>✅ You're in!</h2><p style="margin:0">Names will be drawn ${when}. We'll let everyone know.</p></div>`;
    } else if (!me.spun) {
      main = `<div class="card red center"><h2>🎅 Names have been drawn!</h2><p>Spin the wheel to find out who you're buying for. It's a secret — don't tell!</p>
        <a class="btn big white" href="#spin" style="color:var(--red)">🎡 Spin the wheel!</a></div>`;
    } else {
      main = `<div class="card red center"><p style="margin:0">🤫 You're Secret Santa for</p><div class="display" style="font-size:2.4rem;margin:4px 0 14px">${esc(me.receiverName)}</div>
        <a class="btn white" href="#giftee" style="color:var(--red)">🎁 See ${esc(firstName(me.receiverName))}'s wish list</a>
        <a class="btn white" href="#thread/giftee" style="color:var(--red)">✉️ Ask ${esc(firstName(me.receiverName))} a secret question ${me.unreadGiftee ? `<span class="badge">${me.unreadGiftee}</span>` : ''}</a></div>`;
    }
    const resetBanner = me.pinResetNotice ? `<div class="card notice"><strong>Heads up:</strong> the organizer reset your PIN. If you didn't ask for this, please let them know.
      <div style="margin-top:10px"><button class="btn small" data-act="ack">OK, got it</button><a class="btn small white" href="#settings">Change my PIN</a></div></div>` : '';
    const santaNote = me.unreadSanta ? `<div class="card notice"><strong>🎅 Your Secret Santa sent you a message!</strong><br><a class="btn small" href="#thread/santa" style="margin-top:10px">Read it</a></div>` : '';
    app.innerHTML = `<div class="page-head"><h1>Hi ${esc(firstName(me.name))}! 🎄</h1></div>
      ${resetBanner}${santaNote}${main}
      ${me.wishCount ? '' : `<div class="card"><h3>📝 Your wish list is empty</h3><p>Add a few ideas so your Secret Santa knows what you'd like.</p><a class="btn" href="#mylist">Add to my wish list</a></div>`}
      ${infoCards()}
      ${S.rsvpOpen ? `<div class="card"><h3>👨‍👩‍👧 Invite family</h3><p>Anyone with the link can join.</p><a class="btn whatsapp" href="${whatsappInvite()}" target="_blank" rel="noopener">Share on WhatsApp</a></div>` : ''}
      ${await notifCard()}
      ${whoIsIn()}
      <p class="center"><a href="#settings">⚙️ My settings</a></p>`;
    wireNotif(app);
    app.querySelector('[data-act=ack]')?.addEventListener('click', async () => { await api('/api/me/ack-reset', { method: 'POST' }); await refresh(); render(); });
  }

  // ------------------------------------------------------------ the wheel
  function drawWheel(canvas, names, rotation) {
    const ctx = canvas.getContext('2d');
    const size = canvas.width, r = size / 2, n = names.length, seg = (Math.PI * 2) / n;
    const palette = ['#c8102e', '#17693a', '#c99a2e', '#1d1a17'];
    ctx.clearRect(0, 0, size, size);
    ctx.save(); ctx.translate(r, r); ctx.rotate(rotation);
    for (let i = 0; i < n; i++) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r - 4, i * seg, (i + 1) * seg); ctx.closePath();
      ctx.fillStyle = n % 4 === 1 && i === n - 1 ? '#9e0b23' : palette[i % palette.length]; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
      ctx.save(); ctx.rotate(i * seg + seg / 2); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      const fs = Math.max(16, Math.min(34, (size / n) * 1.2, 40));
      ctx.font = `700 ${fs}px Fredoka, Nunito, sans-serif`;
      let label = names[i];
      while (ctx.measureText(label).width > r * 0.66 && label.length > 3) label = label.slice(0, -2) + '…';
      ctx.fillText(label, r - 26, 0); ctx.restore();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(r, r, r - 3, 0, Math.PI * 2); ctx.strokeStyle = '#c99a2e'; ctx.lineWidth = 8; ctx.stroke();
  }
  function confetti() {
    const bits = ['🎁', '🎄', '⭐', '🎅', '❤️', '💚', '✨'];
    for (let i = 0; i < 40; i++) {
      const el = document.createElement('div');
      el.className = 'confetti'; el.textContent = bits[i % bits.length];
      el.style.left = Math.random() * 100 + 'vw';
      el.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      el.style.animationDelay = Math.random() * 0.8 + 's';
      document.body.appendChild(el); setTimeout(() => el.remove(), 6000);
    }
  }
  function viewSpin() {
    setTabs('home');
    const me = S.me;
    if (S.phase !== 'drawn' || !me.hasMatch) return go('#home');
    if (me.spun) return go('#giftee');
    const preview = S.participants.filter((n) => n !== me.name);
    app.innerHTML = `<div class="page-head center">${backLink()}<h1>🎡 Spin the wheel!</h1><p>Tap the big button and see who you got.</p></div>
      <div class="wheel-wrap"><div class="wheel-pointer" aria-hidden="true"></div><canvas id="wheel" width="840" height="840" role="img" aria-label="Spinning wheel of family names"></canvas><div class="wheel-hub" aria-hidden="true">🎅</div></div>
      <div id="spin-area"><button class="btn big red" id="spin-btn">SPIN! 🎁</button></div>`;
    const canvas = document.getElementById('wheel');
    let names = preview.length ? preview : ['🎁'];
    drawWheel(canvas, names, 0);
    document.getElementById('spin-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Spinning…';
      let result;
      try { result = await api('/api/spin', { method: 'POST' }); } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'SPIN! 🎁'; return; }
      names = result.wheel.length ? result.wheel : [result.receiver];
      const n = names.length, seg = (Math.PI * 2) / n;
      const idx = Math.max(0, names.indexOf(result.receiver));
      // Pointer is at the top (−90°). Land the middle of the winning slice under it, with a little wobble.
      const wobble = (Math.random() - 0.5) * seg * 0.6;
      const target = -Math.PI / 2 - (idx * seg + seg / 2) + wobble;
      const turns = 6 + Math.floor(Math.random() * 3);
      const end = target - Math.PI * 2 * turns;
      const start = 0, dur = 5600, t0 = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        drawWheel(canvas, names, start + (end - start) * ease(t));
        if (t < 1) return requestAnimationFrame(step);
        if (navigator.vibrate) navigator.vibrate([80, 60, 160]);
        confetti();
        document.getElementById('spin-area').innerHTML = `<div class="card reveal"><p style="margin:0">🎉 You're Secret Santa for…</p>
          <div class="big-name">${esc(result.receiver)}</div><p class="muted">Shh! 🤫 Keep it a secret.</p>
          <a class="btn" href="#giftee">🎁 See ${esc(firstName(result.receiver))}'s wish list</a>
          <a class="btn white" href="#thread/giftee">✉️ Ask ${esc(firstName(result.receiver))} a secret question</a></div>`;
        refresh();
      };
      requestAnimationFrame(step);
    });
  }

  // ------------------------------------------------------------ wish lists
  function wishItems(items, { canDelete = false } = {}) {
    if (!items.length) return '';
    return items.map((w) => `<div class="wish"><span class="w-icon" aria-hidden="true">🎁</span><div class="w-body">${esc(w.text)}${safeUrl(w.link) ? `<br><a href="${esc(w.link)}" target="_blank" rel="noopener">Open link ↗</a>` : ''}</div>
      ${canDelete ? `<button class="w-del" data-del="${w.id}" aria-label="Remove ${esc(w.text)}">Remove</button>` : ''}</div>`).join('');
  }
  function aboutBlock(w) {
    const rows = [['👕 Sizes', w.sizes], ['🎨 Favourite colours & things', w.colours], ['🚫 Please no…', w.no_thanks]].filter(([, v]) => v);
    return rows.length ? `<dl class="about">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
  }
  async function viewGiftee() {
    setTabs('home');
    if (!S.me.spun) return go('#home');
    const w = await api('/api/match');
    const fn = esc(firstName(w.name));
    app.innerHTML = `<div class="page-head">${backLink()}<h1>🎁 ${esc(w.name)}'s wish list</h1><p class="muted">You're their Secret Santa. Budget: ${esc(S.settings.budget)}</p></div>
      <div class="card">${wishItems(w.items) || `<p>${fn} hasn't added anything yet. Ask them a secret question, or check back later!</p>`}</div>
      ${aboutBlock(w) ? `<div class="card"><h3>About ${fn}</h3>${aboutBlock(w)}</div>` : ''}
      <a class="btn" href="#thread/giftee">✉️ Ask ${fn} a secret question</a>`;
  }
  async function viewMyList() {
    setTabs('mylist');
    const w = await api('/api/wishes');
    app.innerHTML = `<div class="page-head"><h1>📝 My wish list</h1><p>Your Secret Santa will see this. Add as many ideas as you like!</p></div>
      <div class="card" id="items">${wishItems(w.items, { canDelete: true }) || '<p class="muted" style="margin:0">Nothing yet — add your first idea below.</p>'}</div>
      <form class="card" id="wish-form" novalidate>
        <h3>➕ Add an idea</h3>
        <label for="text">What would you like?<span class="hint">e.g. "Blue water bottle from PriceSmart" or "Gift card for Massy"</span></label>
        <textarea id="text" maxlength="300" required></textarea>
        <label for="link">Link (optional)<span class="hint">Paste a web link to the item, if you have one.</span></label>
        <input id="link" type="text" inputmode="url" autocapitalize="off" maxlength="500">
        <button class="btn" type="submit">Add to my list</button>
      </form>
      <form class="card" id="about-form" novalidate>
        <h3>🙋 About me</h3><p class="small-text muted">Optional, but it really helps!</p>
        <label for="sizes">My sizes<span class="hint">Shirt, shoes, etc.</span></label>
        <input id="sizes" type="text" maxlength="300" value="${esc(w.sizes)}">
        <label for="colours">Favourite colours & things I like</label>
        <input id="colours" type="text" maxlength="300" value="${esc(w.colours)}">
        <label for="no_thanks">Please no…<span class="hint">Allergies, things you already have, etc.</span></label>
        <input id="no_thanks" type="text" maxlength="300" value="${esc(w.no_thanks)}">
        <button class="btn white" type="submit">Save</button>
      </form>`;
    const f = document.getElementById('wish-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('[type=submit]'), async () => {
        try { await api('/api/wishes', { method: 'POST', body: { text: f.text.value, link: f.link.value } }); await refresh(); toast('Added! 🎁'); render(); }
        catch (err) { showError(f, err.message); }
      });
    });
    app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this from your list?')) return;
      await api(`/api/wishes/${b.dataset.del}`, { method: 'DELETE' }); await refresh(); render();
    }));
    const a = document.getElementById('about-form');
    a.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(a.querySelector('[type=submit]'), async () => {
        try { await api('/api/me', { method: 'POST', body: { sizes: a.sizes.value, colours: a.colours.value, no_thanks: a.no_thanks.value } }); toast('Saved! ✅'); }
        catch (err) { showError(a, err.message); }
      });
    });
  }

  // ------------------------------------------------------------ messages
  function viewMessages() {
    setTabs('messages');
    const me = S.me;
    if (S.phase !== 'drawn' || !me.hasMatch) {
      app.innerHTML = `<div class="page-head"><h1>✉️ Secret messages</h1></div>
        <div class="card"><p>Once names are drawn, you can send secret messages here:</p>
        <ul><li>Ask the person you're buying for what they'd like — <strong>they won't know it's you</strong>.</li>
        <li>Answer questions from your own Secret Santa.</li></ul>
        <p style="margin:0">For everyone, use the <a href="#wall">Family Chat</a>.</p></div>`;
      return;
    }
    const giftee = me.spun
      ? `<a class="btn" href="#thread/giftee">🎁 Chat with ${esc(firstName(me.receiverName))} ${me.unreadGiftee ? `<span class="badge">${me.unreadGiftee}</span>` : ''}</a><p class="small-text muted">You're buying for ${esc(firstName(me.receiverName))}. They'll see you as "Your Secret Santa".</p>`
      : `<a class="btn red" href="#spin">🎡 Spin the wheel first</a>`;
    app.innerHTML = `<div class="page-head"><h1>✉️ Secret messages</h1></div>
      <div class="card"><h3>The person you're buying for</h3>${giftee}</div>
      <div class="card"><h3>Your own Secret Santa</h3><a class="btn white" href="#thread/santa">🎅 Chat with my Secret Santa ${me.unreadSanta ? `<span class="badge">${me.unreadSanta}</span>` : ''}</a>
      <p class="small-text muted">Someone is buying for you! You won't see who they are.</p></div>`;
  }
  async function viewThread(which) {
    setTabs('messages');
    let data;
    try { data = await api(`/api/thread/${which}`); } catch (err) { toast(err.message); return go('#messages'); }
    const isGiftee = which === 'giftee';
    const title = isGiftee ? `✉️ To ${esc(data.otherName)}` : '🎅 My Secret Santa';
    const explain = isGiftee
      ? `${esc(firstName(data.otherName))} will see your messages from <strong>"Your Secret Santa"</strong>. Your name stays hidden.`
      : "This is your Secret Santa. You can't see who they are — but you can answer their questions!";
    const theirLabel = isGiftee ? esc(firstName(data.otherName)) : 'Secret Santa 🎅';
    app.innerHTML = `<div class="page-head">${backLink('messages', 'Messages')}<h1>${title}</h1><p class="small-text">${explain}</p></div>
      <div class="thread">${data.messages.map((m) => `<div class="bubble ${m.mine ? 'mine' : ''}">${linkify(m.body)}<span class="meta">${m.mine ? 'You' : theirLabel} · ${esc(fmtWhen(m.at))}</span></div>`).join('') || `<div class="card muted">No messages yet. ${isGiftee ? `Try: "What colour do you like?" or "Do you need anything for the kitchen?"` : 'Your Secret Santa may write to you soon!'}</div>`}</div>
      <form class="card" id="msg-form" novalidate>
        <label for="body">${isGiftee ? 'Your secret question' : 'Your message'}</label>
        <textarea id="body" maxlength="1000" required></textarea>
        <button class="btn" type="submit">Send ✉️</button>
      </form>`;
    window.scrollTo(0, document.body.scrollHeight);
    const f = document.getElementById('msg-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('[type=submit]'), async () => {
        try { await api(`/api/thread/${which}`, { method: 'POST', body: { body: f.body.value } }); toast('Sent! ✉️'); await refresh(); render(); }
        catch (err) { showError(f, err.message); }
      });
    });
    refresh().then(() => setTabs('messages'));
  }

  // ------------------------------------------------------------ family wall
  async function viewWall() {
    setTabs('wall');
    const { posts } = await api('/api/wall');
    app.innerHTML = `<div class="page-head"><h1>💬 Family Chat</h1><p class="small-text">Everyone in the Secret Santa can see this. Don't give away who you got! 🤫</p></div>
      <form class="card" id="wall-form" novalidate>
        <label for="body">Write something to the family</label>
        <textarea id="body" maxlength="1000" required></textarea>
        <button class="btn" type="submit">Post</button>
      </form>
      <div class="card">${posts.map((p) => `<div class="post ${p.announcement ? 'announce' : ''}"><div class="who">${p.announcement ? '<span class="avatar" style="background:#c99a2e">📣</span>' : avatar(p.name)}<span>${esc(p.name)} <span class="when">· ${esc(fmtWhen(p.at))}</span></span></div>
        <div class="text">${linkify(p.body)}</div>${p.mine ? `<button class="link-btn del" data-del="${p.id}">Delete</button>` : ''}</div>`).join('') || '<p class="muted" style="margin:0">No posts yet. Say hello! 👋</p>'}</div>`;
    const f = document.getElementById('wall-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('[type=submit]'), async () => {
        try { await api('/api/wall', { method: 'POST', body: { body: f.body.value } }); render(); }
        catch (err) { showError(f, err.message); }
      });
    });
    app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this post?')) return;
      await api(`/api/wall/${b.dataset.del}`, { method: 'DELETE' }); render();
    }));
    refresh().then(() => setTabs('wall'));
  }

  // ------------------------------------------------------------ settings
  async function viewSettings() {
    setTabs('home');
    const me = S.me;
    app.innerHTML = `<div class="page-head">${backLink()}<h1>⚙️ My settings</h1></div>
      ${S.emailEnabled ? `<form class="card" id="email-form" novalidate><h3>📧 Email alerts</h3>
        <label for="email">Email (optional)<span class="hint">Get an email when names are drawn or you get a secret message. Leave blank for none.</span></label>
        <input id="email" type="email" inputmode="email" value="${esc(me.email)}"><button class="btn white" type="submit">Save email</button></form>` : ''}
      ${await notifCard()}
      <form class="card" id="pin-form" novalidate><h3>🔢 Change my PIN</h3>
        <label for="pin">New 4-number PIN</label><input id="pin" class="pin-input" type="tel" inputmode="numeric" maxlength="4" autocomplete="off">
        <button class="btn white" type="submit">Change PIN</button></form>
      <div class="card"><h3>👋 Sign out</h3><p class="small-text">Only if this isn't your phone. You'll need your PIN to sign back in.</p><button class="btn white" data-act="logout">Sign out</button></div>
      ${S.phase !== 'drawn' ? `<div class="card"><h3>Can't take part this year?</h3><button class="btn white" data-act="withdraw">I can't take part</button></div>` : ''}`;
    wireNotif(app);
    document.getElementById('email-form')?.addEventListener('submit', (e) => {
      e.preventDefault(); const f = e.currentTarget;
      busy(f.querySelector('[type=submit]'), async () => { try { await api('/api/me', { method: 'POST', body: { email: f.email.value.trim() } }); await refresh(); toast('Saved! ✅'); } catch (err) { showError(f, err.message); } });
    });
    document.getElementById('pin-form').addEventListener('submit', (e) => {
      e.preventDefault(); const f = e.currentTarget;
      busy(f.querySelector('[type=submit]'), async () => { try { await api('/api/me/pin', { method: 'POST', body: { pin: f.pin.value.trim() } }); f.pin.value = ''; await refresh(); toast('PIN changed ✅'); } catch (err) { showError(f, err.message); } });
    });
    app.querySelector('[data-act=logout]').addEventListener('click', async () => {
      if (!confirm('Sign out of Secret Santa on this phone?')) return;
      await api('/api/logout', { method: 'POST' }); await refresh(); go('');
    });
    app.querySelector('[data-act=withdraw]')?.addEventListener('click', async () => {
      if (!confirm("Take yourself out of this year's Secret Santa?")) return;
      try { await api('/api/me/withdraw', { method: 'POST' }); await refresh(); toast("You've been taken out. Merry Christmas! 💚"); go(''); } catch (err) { toast(err.message); }
    });
  }

  // ------------------------------------------------------------ organizer
  async function viewOrganizer() {
    setTabs(null);
    let o;
    try { o = await api('/api/admin/overview'); } catch (err) {
      if (err.status !== 401) throw err;
      app.innerHTML = `<div class="page-head">${backLink('', 'Back to the site')}<h1>🔐 Organizer</h1></div>
        <form class="card" id="admin-login" novalidate><label for="pw">Organizer password</label><input id="pw" type="password" autocomplete="current-password"><button class="btn" type="submit">Sign in</button></form>`;
      const f = document.getElementById('admin-login');
      f.addEventListener('submit', (e) => { e.preventDefault(); busy(f.querySelector('[type=submit]'), async () => { try { await api('/api/admin/login', { method: 'POST', body: { password: f.pw.value } }); render(); } catch (e2) { showError(f, e2.message); } }); });
      return;
    }
    const st = o.settings;
    const yes = o.people.filter((p) => p.rsvp === 'yes'), no = o.people.filter((p) => p.rsvp === 'no');
    const phaseText = { rsvp: '🟢 RSVPs are open', closed: '🟡 RSVPs closed — waiting for the draw', drawn: '🎁 Names have been drawn' }[o.phase];
    const spunCount = yes.filter((p) => p.spun).length;
    const personRow = (p) => `<div class="person-row"><div class="pr-top"><span class="pr-name">${esc(p.name)}</span>
      <span>${p.rsvp === 'yes' ? `<button class="btn small white" data-reset="${p.id}" data-name="${esc(p.name)}">Reset PIN</button>` : ''}<button class="btn small white" data-remove="${p.id}" data-name="${esc(p.name)}" data-indraw="${p.in_draw ? 1 : 0}">Remove</button></span></div>
      <div class="pr-tags">${p.rsvp === 'yes' ? '<span class="tag yes">In</span>' : '<span class="tag no">Not this year</span>'}
        ${p.rsvp === 'yes' && o.phase === 'drawn' ? (p.in_draw ? (p.spun ? '<span class="tag yes">Spun ✓</span>' : '<span class="tag">Hasn\'t spun yet</span>') : '<span class="tag warn">Not in draw yet</span>') : ''}
        ${p.rsvp === 'yes' ? `<span class="tag">${p.wishes ? `📝 ${p.wishes} wish${p.wishes === 1 ? '' : 'es'}` : '📝 No wish list'}</span>` : ''}
        ${p.push ? '<span class="tag">🔔 Notifications</span>' : ''}${p.email ? '<span class="tag">📧 Email</span>' : ''}${p.locked ? '<span class="tag warn">Locked out (wrong PIN)</span>' : ''}</div>
      ${p.rsvp === 'yes' ? `<label class="small-text" for="hh-${p.id}" style="font-weight:700;margin:6px 0 0">Household</label><input class="hh-input" id="hh-${p.id}" type="text" data-hh="${p.id}" value="${esc(p.household)}" placeholder="No household (can draw anyone)">` : ''}
      ${o.phase === 'drawn' && p.rsvp === 'yes' && !p.in_draw ? `<button class="btn small" data-fit="${p.id}">Fit into draw</button>` : ''}</div>`;

    app.innerHTML = `<div class="page-head">${backLink('', 'Back to the site')}<h1>🎅 Organizer</h1>
      <p class="small-text muted">You can see who's in and how things are going — but <strong>never who drew whom</strong>.</p></div>
      <div class="card ${o.phase === 'drawn' ? 'green' : ''}"><h2>${phaseText}</h2>
        <p>${yes.length} in · ${no.length} said no${o.phase === 'drawn' ? ` · ${spunCount} of ${yes.filter((p) => p.in_draw).length} have spun` : ''}</p>
        ${o.drawError ? `<div class="error">The draw didn't happen: ${esc(o.drawError)}</div>` : ''}
        ${o.unmatched.length ? `<div class="error">Not fully in the draw: ${o.unmatched.map(esc).join(', ')}. Use "Fit into draw" below.</div>` : ''}
        ${o.phase !== 'drawn' ? `<p class="small-text">${st.draw_at ? `Names will be drawn automatically on <strong>${esc(fmtDateTime(st.draw_at))}</strong>.` : 'No draw date set yet — set one below, or draw now.'}</p>
          <button class="btn red" data-act="draw">🎲 Draw names now</button>`
        : `<p class="small-text">Drawn ${esc(fmtDateTime(o.drawnAt))}.</p>
          <label style="display:flex;gap:10px;align-items:center;font-weight:700"><input type="checkbox" id="late" ${st.late_join === '1' ? 'checked' : ''} style="width:26px;height:26px"> Let late people still join (they're slotted in automatically)</label>
          <button class="btn small white" data-act="undo" style="margin-top:10px">Cancel the draw</button>`}
      </div>

      <div class="card"><h3>📤 Share the invite</h3><p class="small-text">Post this in the family WhatsApp. Anyone can forward it.</p>
        <a class="btn whatsapp" href="${whatsappInvite()}" target="_blank" rel="noopener">Share on WhatsApp</a>
        <button class="btn white" data-act="copy">Copy the link</button></div>

      <form class="card" id="settings-form" novalidate><h3>🗓️ Dates & details</h3>
        <label for="title">Title</label><input id="title" type="text" value="${esc(st.title)}">
        <label for="welcome">Welcome message</label><textarea id="welcome">${esc(st.welcome)}</textarea>
        <div class="row"><div><label for="rsvp_deadline">RSVP by<span class="hint">Trinidad time</span></label><input id="rsvp_deadline" type="datetime-local" value="${toLocalInput(st.rsvp_deadline)}"></div>
        <div><label for="draw_at">Draw names on<span class="hint">Happens automatically</span></label><input id="draw_at" type="datetime-local" value="${toLocalInput(st.draw_at)}"></div></div>
        <div class="row"><div><label for="budget">Gift budget</label><input id="budget" type="text" value="${esc(st.budget)}"></div>
        <div><label for="budget_note">Budget note</label><input id="budget_note" type="text" value="${esc(st.budget_note)}"></div></div>
        <label for="organizer_name">Organizer name<span class="hint">Shown when someone needs help, e.g. "Message Holly to reset your PIN"</span></label><input id="organizer_name" type="text" value="${esc(st.organizer_name)}">
        <label for="exchange_note">Gift exchange (optional)<span class="hint">e.g. "Christmas Day lunch at Granny's"</span></label><input id="exchange_note" type="text" value="${esc(st.exchange_note)}">
        <label for="households">Households<span class="hint">One family per line. People in the same household won't draw each other. When someone RSVPs, their first name is matched to this list. You can also edit each person's household below.</span></label>
        <textarea id="households" style="min-height:200px">${esc(st.households)}</textarea>
        <button class="btn" type="submit">Save</button></form>

      <div class="card"><h3>👨‍👩‍👧‍👦 People (${o.people.length})</h3>
        ${o.people.map(personRow).join('') || '<p class="muted">Nobody has answered yet.</p>'}</div>

      <form class="card" id="announce-form" novalidate><h3>📣 Send an announcement</h3><p class="small-text">Posts in the Family Chat and pings everyone.</p>
        <textarea id="body" maxlength="1000"></textarea>
        ${o.emailEnabled ? '<label style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="annEmail" style="width:24px;height:24px"> Also email people who gave an email</label>' : ''}
        <button class="btn" type="submit">Send announcement</button></form>

      <div class="card"><h3>🧾 Activity</h3><div class="log">${o.log.map((l) => `<div><span class="muted small-text">${esc(fmtWhen(l.at))}</span><br>${esc(l.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></div>

      <div class="card"><details><summary>⚠️ Practice run tools</summary>
        <p class="small-text">After a practice run, this clears everyone out (people, wish lists, messages, draw). Dates and settings are kept.</p>
        <button class="btn small red" data-act="reset-all">Clear everyone out</button></details>
        ${o.emailEnabled ? `<form id="test-email" class="row" style="margin-top:12px" novalidate><input id="te" type="email" placeholder="Your email" style="margin:0"><button class="btn small white" type="submit" style="flex:0 0 auto">Send test email</button></form>` : ''}
        <p class="small-text muted" style="margin-top:12px">Email alerts: ${o.emailEnabled ? 'on ✅' : 'not set up'} · Helper key for the sealed list: ${o.opsEnabled ? 'set up ✅' : 'not set up'}</p>
        <button class="link-btn" data-act="admin-logout">Sign out of organizer</button></div>`;

    const reload = () => render();
    app.querySelector('[data-act=draw]')?.addEventListener('click', (e) => {
      if (!confirm(`Draw names now for the ${yes.length} people who said yes? Everyone will be notified.`)) return;
      busy(e.currentTarget, async () => { try { const r = await api('/api/admin/draw', { method: 'POST' }); toast(`Names drawn for ${r.count} people! 🎉`); reload(); } catch (err) { toast(err.message); } });
    });
    app.querySelector('[data-act=undo]')?.addEventListener('click', async () => {
      if (!confirm('Cancel the draw? Everyone goes back to waiting and secret messages are cleared.')) return;
      try { await api('/api/admin/undo-draw', { method: 'POST' }); }
      catch (err) {
        if (!confirm(`${err.message}\n\nCancel anyway?`)) return;
        await api('/api/admin/undo-draw', { method: 'POST', body: { force: true } });
      }
      toast('Draw cancelled. Set a new draw date.'); reload();
    });
    app.querySelector('#late')?.addEventListener('change', async (e) => { await api('/api/admin/settings', { method: 'POST', body: { late_join: e.target.checked } }); toast('Saved ✅'); });
    app.querySelector('[data-act=copy]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(siteUrl()); toast('Link copied!'); } catch { prompt('Copy this link:', siteUrl()); } });
    const sf = document.getElementById('settings-form');
    sf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(sf.querySelector('[type=submit]'), async () => {
        try {
          await api('/api/admin/settings', { method: 'POST', body: {
            title: sf.elements.namedItem('title').value, welcome: sf.welcome.value, budget: sf.budget.value, budget_note: sf.budget_note.value, exchange_note: sf.exchange_note.value, organizer_name: sf.organizer_name.value,
            rsvp_deadline: fromLocalInput(sf.rsvp_deadline.value), draw_at: fromLocalInput(sf.draw_at.value), households: sf.households.value,
          } });
          await refresh(); toast('Saved ✅'); reload();
        } catch (err) { showError(sf, err.message); }
      });
    });
    app.querySelectorAll('[data-hh]').forEach((inp) => inp.addEventListener('change', async () => {
      await api(`/api/admin/person/${inp.dataset.hh}`, { method: 'POST', body: { household: inp.value } }); toast('Household saved ✅');
    }));
    app.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const pin = prompt(`New 4-number PIN for ${b.dataset.name}:\n(They'll see a notice that it was reset.)`);
      if (pin === null) return;
      try { await api(`/api/admin/person/${b.dataset.reset}/reset-pin`, { method: 'POST', body: { pin: pin.trim() } }); toast(`PIN reset. Tell ${b.dataset.name} their new PIN.`); reload(); } catch (err) { toast(err.message); }
    }));
    app.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      const extra = b.dataset.indraw === '1' ? '\n\nNames are already drawn. The draw will be patched automatically, and anyone whose person changes will be told.' : '';
      if (!confirm(`Remove ${b.dataset.name}?${extra}`)) return;
      try { const r = await api(`/api/admin/person/${b.dataset.remove}/remove`, { method: 'POST' }); toast(r.problem || `${b.dataset.name} removed.`); reload(); } catch (err) { toast(err.message); }
    }));
    app.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/person/${b.dataset.fit}/fit`, { method: 'POST' }); toast('Added into the draw ✅'); reload(); } catch (err) { toast(err.message); }
    }));
    document.getElementById('test-email')?.addEventListener('submit', (e) => {
      e.preventDefault(); const f = e.currentTarget;
      busy(f.querySelector('[type=submit]'), async () => { try { await api('/api/admin/test-email', { method: 'POST', body: { email: f.te.value.trim() } }); toast('Test email sent! Check your inbox (and spam).'); } catch (err) { toast(err.message); } });
    });
    const af = document.getElementById('announce-form');
    af.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(af.querySelector('[type=submit]'), async () => {
        try { await api('/api/admin/announce', { method: 'POST', body: { body: af.body.value, email: af.annEmail?.checked } }); toast('Announcement sent 📣'); reload(); } catch (err) { showError(af, err.message); }
      });
    });
    app.querySelector('[data-act=reset-all]').addEventListener('click', async () => {
      const c = prompt('This removes EVERYONE and all wish lists, messages and the draw.\nType RESET to confirm:');
      if (c !== 'RESET') return;
      await api('/api/admin/reset-all', { method: 'POST', body: { confirm: 'RESET' } }); toast('Cleared. Fresh start!'); reload();
    });
    app.querySelector('[data-act=admin-logout]').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); go(''); });
  }

  // ------------------------------------------------------------ router
  async function render() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [page, arg] = hash.split('/');
    try {
      if (!S) await refresh();
      if (page === 'organizer') return await viewOrganizer();
      if (!S.me) {
        if (page === 'join') return viewJoin();
        if (page === 'decline') return viewDecline();
        if (page === 'signin') return await viewSignin(arg);
        if (page && page !== 'home') { /* needs sign-in */ return await viewSignin(); }
        return viewLanding();
      }
      switch (page) {
        case 'welcome': return await viewWelcome();
        case 'spin': return viewSpin();
        case 'giftee': return await viewGiftee();
        case 'mylist': return await viewMyList();
        case 'messages': return viewMessages();
        case 'thread': return await viewThread(arg === 'santa' ? 'santa' : 'giftee');
        case 'wall': return await viewWall();
        case 'settings': return await viewSettings();
        default: return await viewHome();
      }
    } catch (err) {
      if (err.status === 401 && page !== 'organizer') { await refresh().catch(() => {}); return viewSignin(); }
      app.innerHTML = `<div class="page-head"><h1>Oops! 🎅</h1><p>${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    }
  }
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  // Refresh badges when someone comes back to the app.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S || !S.me) return;
    const before = JSON.stringify([S.phase, S.me.unreadGiftee, S.me.unreadSanta, S.me.wallNew]);
    await refresh().catch(() => {});
    if (S.me && JSON.stringify([S.phase, S.me.unreadGiftee, S.me.unreadSanta, S.me.wallNew]) !== before) render();
  });
  if ('serviceWorker' in navigator) getReg().catch(() => {});
  render();
})();
