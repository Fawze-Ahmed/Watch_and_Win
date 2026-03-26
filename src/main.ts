import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import './style.css'

type Page = 'home' | 'about' | 'signup' | 'login' | 'dashboard' | 'earn' | 'withdraw' | 'store' | 'mining' | 'contact' | 'admin'
type Status = 'pending' | 'approved' | 'processing' | 'rejected' | 'completed'
type Source = 'video' | 'short_link' | 'daily_bonus' | 'redeem'

const app = document.querySelector<HTMLDivElement>('#app')!
const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
const OWNER_EMAIL = import.meta.env.VITE_OWNER_EMAIL || 'owner@fth.app'
const USD_PER_FTH = 0.05
const MIN_WITHDRAW_FTH = 400
const TASKS = [
  { id: 1, title: 'مشاهدة إعلان ممول', reward: 12, source: 'video', cta: 'شاهد الآن', desc: 'افتح الإعلان وأكمل المشاهدة لتحصل على رصيد FTH.' },
  { id: 2, title: 'فتح رابط مختصر', reward: 7, source: 'short_link', cta: 'افتح الرابط', desc: 'افتح الرابط المطلوب ثم ارجع للمنصة لتأكيد المهمة.' },
  { id: 3, title: 'مكافأة يومية', reward: 5, source: 'daily_bonus', cta: 'استلام', desc: 'مكافأة بسيطة للعودة اليومية إلى الموقع.' },
]

const state = {
  page: 'home' as Page,
  loading: true,
  busy: false,
  note: '',
  noteType: 'success' as 'success' | 'error',
  profile: null as null | { id: string; name: string; email: string; balance: number },
  activities: [] as Array<{ id: string; source: Source; amount: number; status: Status; created_at: string }>,
  requests: [] as Array<{ id: string; user_id: string; user_name: string; wallet: string; amount: number; balance: number; status: Status; created_at: string }>,
  threads: [] as Array<{ id: string; user_id: string; user_name: string; user_email: string; status: string; messages: Array<{ id: string; sender: string; text: string; created_at: string }> }>,
  selectedThreadId: '',
  wallet: '',
  amount: '',
  userMsg: '',
  ownerMsg: '',
}

let realtime: RealtimeChannel | null = null

const seed = (() => {
  const key = localStorage.getItem('fth-key') || crypto.randomUUID()
  const name = localStorage.getItem('fth-name') || `Member-${key.slice(0, 6)}`
  const email = localStorage.getItem('fth-email') || `${key.slice(0, 8)}@fth.local`
  localStorage.setItem('fth-key', key); localStorage.setItem('fth-name', name); localStorage.setItem('fth-email', email)
  return { key, name, email }
})()

const fmtDate = (v: string) => new Intl.DateTimeFormat('ar', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v))
const fmtCoin = (n: number) => `${n.toLocaleString('en-US')} FTH`
const fmtUsd = (n: number) => `$${n.toFixed(2)}`
const statusLabel = (s: string) => ({ pending: 'معلق', approved: 'تم التأكيد', processing: 'قيد المراجعة', rejected: 'مرفوض', completed: 'مكتمل' }[s] || s)
const sourceLabel = (s: string) => ({ video: 'إعلان', short_link: 'رابط مختصر', daily_bonus: 'مكافأة يومية', redeem: 'طلب سحب' }[s] || s)
const currentBalance = () => state.profile?.balance || 0

function note(msg = '', type: 'success' | 'error' = 'success') { state.note = msg; state.noteType = type }

async function ensureProfile() {
  const { data, error } = await supabase.from('profiles').upsert({
    device_key: seed.key, display_name: seed.name, email: seed.email, role: 'user',
  }, { onConflict: 'device_key' }).select('id,display_name,email,coin_balance').single()
  if (error) throw error
  state.profile = { id: data.id, name: data.display_name || seed.name, email: data.email || seed.email, balance: data.coin_balance }
}

async function loadData() {
  if (!state.profile) return
  const [p, tx, rq, profiles, threads] = await Promise.all([
    supabase.from('profiles').select('coin_balance').eq('id', state.profile.id).single(),
    supabase.from('wallet_transactions').select('id,source,amount,status,created_at').eq('user_id', state.profile.id).order('created_at', { ascending: false }).limit(12),
    supabase.from('redeem_requests').select('id,user_id,coin_amount,payout_details,status,created_at').order('created_at', { ascending: false }),
    supabase.from('profiles').select('id,display_name,email,coin_balance'),
    supabase.from('support_threads').select('id,user_id,status,profiles!support_threads_user_id_fkey(display_name,email),support_messages(id,sender_role,message_text,created_at)').order('created_at', { ascending: false }),
  ])
  if (p.error || tx.error || rq.error || profiles.error || threads.error) throw (p.error || tx.error || rq.error || profiles.error || threads.error)
  state.profile.balance = p.data.coin_balance
  state.activities = tx.data as any
  const map = new Map((profiles.data as any[]).map((x) => [x.id, x]))
  state.requests = (rq.data as any[]).map((x) => ({ id: x.id, user_id: x.user_id, user_name: map.get(x.user_id)?.display_name || 'مستخدم', wallet: x.payout_details, amount: x.coin_amount, balance: map.get(x.user_id)?.coin_balance || 0, status: x.status, created_at: x.created_at }))
  state.threads = (threads.data as any[]).map((x) => ({ id: x.id, user_id: x.user_id, user_name: x.profiles?.[0]?.display_name || 'مستخدم', user_email: x.profiles?.[0]?.email || '', status: x.status, messages: (x.support_messages || []).map((m: any) => ({ id: m.id, sender: m.sender_role, text: m.message_text, created_at: m.created_at })) }))
  state.selectedThreadId = state.selectedThreadId || state.threads[0]?.id || ''
}

function subscribe() {
  if (!state.profile) return
  realtime?.unsubscribe()
  realtime = supabase.channel(`fth-${state.profile.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_transactions' }, () => void loadData().then(render))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'redeem_requests' }, () => void loadData().then(render))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'support_messages' }, () => void loadData().then(render))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'support_threads' }, () => void loadData().then(render))
    .subscribe()
}

async function boot() {
  try {
    await ensureProfile(); await loadData(); subscribe(); state.loading = false; render()
  } catch (e: any) { note(e.message || 'خطأ غير متوقع', 'error'); state.loading = false; render() }
}

async function doTask(id: number) {
  const t = TASKS.find((x) => x.id === id); if (!t || !state.profile || state.busy) return
  state.busy = true; render()
  const { error } = await supabase.from('wallet_transactions').insert({ user_id: state.profile.id, source: t.source, amount: t.reward, status: 'completed', notes: t.title })
  if (error) note(error.message, 'error'); else { note(`تمت إضافة ${t.reward} FTH`, 'success'); await loadData() }
  state.busy = false; render()
}

async function sendWithdraw() {
  if (!state.profile || state.busy) return
  const amount = Number(state.amount), wallet = state.wallet.trim()
  if (!wallet) return note('أدخل رابط المحفظة.', 'error'), render()
  if (!amount || amount <= 0) return note('أدخل مبلغًا صحيحًا.', 'error'), render()
  if (currentBalance() * USD_PER_FTH < 20) return note(`الحد الأدنى للسحب ${MIN_WITHDRAW_FTH} FTH`, 'error'), render()
  if (amount > currentBalance()) return note('المبلغ أكبر من الرصيد الحالي.', 'error'), render()
  state.busy = true; render()
  const { error } = await supabase.from('redeem_requests').insert({ user_id: state.profile.id, reward_type: 'withdrawal', coin_amount: amount, payout_details: wallet, status: 'pending' })
  if (error) note(error.message, 'error'); else { state.wallet = ''; state.amount = ''; note('تم إرسال طلب السحب إلى الأدمن.', 'success'); await loadData() }
  state.busy = false; render()
}

async function approve(id: string) {
  const req = state.requests.find((x) => x.id === id); if (!req || state.busy) return
  state.busy = true; render()
  const tx = await supabase.from('wallet_transactions').insert({ user_id: req.user_id, source: 'redeem', amount: -req.amount, status: 'approved', notes: `Approved for ${req.wallet}` })
  const up = await supabase.from('redeem_requests').update({ status: 'approved' }).eq('id', id)
  if (tx.error || up.error) note((tx.error || up.error)?.message || 'تعذر التأكيد', 'error'); else { note('تم تأكيد السحب وخصم الرصيد.', 'success'); await loadData() }
  state.busy = false; render()
}

async function reject(id: string) {
  if (state.busy) return
  state.busy = true; render()
  const { error } = await supabase.from('redeem_requests').update({ status: 'rejected' }).eq('id', id)
  if (error) note(error.message, 'error'); else { note('تم رفض الطلب.', 'success'); await loadData() }
  state.busy = false; render()
}

async function ensureThread() {
  const own = state.threads.find((x) => x.user_id === state.profile?.id); if (own) return own.id
  const { data, error } = await supabase.from('support_threads').insert({ user_id: state.profile?.id, status: 'open', subject: 'Support' }).select('id').single()
  if (error) throw error
  return data.id
}

async function sendUserMessage() {
  if (state.busy || !state.userMsg.trim()) return
  state.busy = true; render()
  try {
    const id = await ensureThread()
    await supabase.from('support_messages').insert({ thread_id: id, sender_role: 'user', message_text: state.userMsg.trim() })
    await supabase.from('support_threads').update({ status: 'needs_reply' }).eq('id', id)
    state.userMsg = ''; note('تم إرسال الرسالة.', 'success'); await loadData()
  } catch (e: any) { note(e.message, 'error') }
  state.busy = false; render()
}

async function sendOwnerMessage() {
  if (state.busy || !state.ownerMsg.trim()) return
  const t = state.threads.find((x) => x.id === state.selectedThreadId); if (!t) return
  state.busy = true; render()
  const a = await supabase.from('support_messages').insert({ thread_id: t.id, sender_role: 'owner', message_text: state.ownerMsg.trim() })
  const b = await supabase.from('support_threads').update({ status: 'resolved' }).eq('id', t.id)
  if (a.error || b.error) note((a.error || b.error)?.message || 'تعذر الرد', 'error'); else { state.ownerMsg = ''; note('تم إرسال الرد.', 'success'); await loadData() }
  state.busy = false; render()
}

const shell = (body: string) => `
  <div class="page-shell">
    <header class="header">
      <div class="brand"><img src="/fth-logo.svg" alt="FTH"><div><strong>FTH</strong><span>Future Token Hub</span></div></div>
      <nav class="nav">${[['home','الرئيسية'],['about','من نحن'],['signup','إنشاء حساب'],['login','تسجيل دخول'],['dashboard','الداش بورد'],['contact','التواصل']].map(([p,l])=>`<button class="nav-btn ${state.page===p?'active':''}" data-page="${p}">${l}</button>`).join('')}</nav>
    </header>
    <main class="main">${state.note ? `<div class="notice ${state.noteType}">${state.note}</div>` : ''}${body}</main>
    <footer class="footer"><div><strong>FTH</strong><p>منصة ربح وعملة رقمية داخلية مع سحب يدوي ولوحة متابعة واضحة. البريد الإداري: ${OWNER_EMAIL}</p></div><div class="footer-actions"><button data-page="contact">التواصل</button><button data-page="store">المتجر</button><button data-page="mining">التعدين</button></div></footer>
  </div>
`

const home = () => shell(`
  <section class="hero">
    <div><span class="kicker">FTH Coin</span><h1>منصة هادئة للربح من الإعلانات والروابط المختصرة</h1><p>شاهد، افتح الروابط المطلوبة، اجمع FTH، ثم أرسل طلب سحب يدوي عند وصول رصيدك إلى ما يعادل 20 دولار.</p><div class="cta-row"><button class="primary" data-page="signup">ابدأ الآن</button><button class="secondary" data-page="about">اعرف المزيد</button></div></div>
    <div class="hero-card"><div><span>اسم العملة</span><strong>FTH</strong></div><div><span>الحد الأدنى للسحب</span><strong>${MIN_WITHDRAW_FTH} FTH</strong></div><div><span>نوع السحب</span><strong>يدوي عبر الأدمن</strong></div></div>
  </section>
  <section class="section grid2"><article class="card"><h2>كيف يعمل الموقع؟</h2><p>يسجل المستخدم، يدخل الداش بورد، يفتح الإعلانات والروابط، ثم تتجمع الأرباح داخل محفظته.</p></article><article class="card"><h2>الأهداف المستقبلية</h2><p>سنضيف المتجر الإلكتروني، التعدين، وتحليلات أوسع للمستخدم والإدارة.</p></article></section>
  <section class="section"><div class="section-head"><span class="kicker">مميزات المنصة</span><h2>ماذا ستجد داخل FTH؟</h2></div><div class="features"><article class="card"><h3>هيدر هادئ وفوتر واضح</h3><p>واجهة أقرب للمواقع الحديثة مع صفحة رئيسية معتدلة ومريحة.</p></article><article class="card"><h3>قسم الأرباح</h3><p>إعلانات وروابط مختصرة ومكافآت يومية لزيادة الرصيد.</p></article><article class="card"><h3>لوحة مستخدم</h3><p>إحصاءات المشاهدات والأرباح وطلبات السحب في مكان واحد.</p></article><article class="card"><h3>لوحة أدمن</h3><p>تأكيد أو رفض طلبات السحب مع متابعة الرسائل.</p></article></div></section>
`)

const about = () => shell(`<section class="section narrow"><span class="kicker">من نحن</span><h1 class="title">نبذة عن FTH</h1><p class="lead">FTH منصة ويب لعرض المهام الإعلانية والروابط المختصرة مع عملة داخلية خاصة بالموقع وواجهة مستخدم بسيطة واحترافية. المتجر الإلكتروني والتعدين سيظهران داخل الموقع كأقسام تحت التطوير حتى نصل إلى المرحلة التالية.</p></section>`)
const auth = (t: string, s: string) => shell(`<section class="section auth"><article class="card auth-card"><span class="kicker">FTH Access</span><h1>${t}</h1><p>${s}</p><div class="auth-grid"><input placeholder="اسم المستخدم"><input placeholder="البريد الإلكتروني"><input type="password" placeholder="كلمة المرور"><button class="primary" data-page="dashboard">متابعة</button></div></article></section>`)

const dashboard = () => {
  const ads = state.activities.filter((x) => x.source === 'video').length, links = state.activities.filter((x) => x.source === 'short_link').length, myReqs = state.requests.filter((x) => x.user_id === state.profile?.id).length
  return shell(`<section class="section"><div class="dash-head"><article class="wallet"><span class="kicker">رصيدك</span><h1>${fmtCoin(currentBalance())}</h1><p>القيمة التقريبية: ${fmtUsd(currentBalance() * USD_PER_FTH)}</p></article><div class="stats"><article class="metric"><span>الإعلانات</span><strong>${ads}</strong></article><article class="metric"><span>الروابط</span><strong>${links}</strong></article><article class="metric"><span>طلبات السحب</span><strong>${myReqs}</strong></article><article class="metric"><span>البريد</span><strong>${state.profile?.email || '-'}</strong></article></div></div><div class="dash-links">${[['earn','قسم الأرباح'],['withdraw','قسم السحب'],['store','المتجر'],['mining','التعدين'],['contact','التواصل'],['admin','لوحة الأدمن']].map(([p,l])=>`<button class="dash-btn" data-page="${p}">${l}</button>`).join('')}</div><div class="list">${state.activities.length?state.activities.map((a)=>`<article class="row"><div><strong>${sourceLabel(a.source)}</strong><p>${fmtDate(a.created_at)}</p></div><div class="row-end"><span class="${a.amount>=0?'positive':'negative'}">${a.amount>=0?'+':''}${fmtCoin(a.amount)}</span><span class="pill">${statusLabel(a.status)}</span></div></article>`).join(''):'<p class="empty">لا توجد عمليات بعد.</p>'}</div></section>`)
}

const earn = () => shell(`<section class="section"><div class="section-head"><span class="kicker">قسم الأرباح</span><h1 class="title">الإعلانات والروابط المختصرة</h1></div><div class="features">${TASKS.map((t)=>`<article class="card"><h3>${t.title}</h3><p>${t.desc}</p><div class="action-row"><strong>${fmtCoin(t.reward)}</strong><button class="primary small" data-task="${t.id}" ${state.busy?'disabled':''}>${t.cta}</button></div></article>`).join('')}</div></section>`)
const withdraw = () => shell(`<section class="section"><div class="section-head"><span class="kicker">قسم السحب</span><h1 class="title">سحب عملة FTH</h1><p class="lead">يمكنك السحب عند وصول رصيدك إلى ${fmtUsd(20)} أو أكثر.</p></div><div class="grid2"><article class="card"><h3>إرسال طلب سحب</h3><div class="auth-grid"><input id="wallet" placeholder="رابط المحفظة" value="${state.wallet}"><input id="amount" type="number" placeholder="المبلغ بـ FTH" value="${state.amount}"><button id="send-withdraw" class="primary" ${state.busy?'disabled':''}>إرسال طلب السحب</button></div><p class="tiny">رصيدك الحالي: ${fmtCoin(currentBalance())}</p></article><article class="card"><h3>طلباتك</h3><div class="list compact">${state.requests.filter((r)=>r.user_id===state.profile?.id).map((r)=>`<article class="row"><div><strong>${r.wallet}</strong><p>${fmtDate(r.created_at)}</p></div><div class="row-end"><span>${fmtCoin(r.amount)}</span><span class="pill">${statusLabel(r.status)}</span></div></article>`).join('') || '<p class="empty">لا توجد طلبات حتى الآن.</p>'}</div></article></div></section>`)
const coming = (t: string, d: string) => shell(`<section class="section narrow"><article class="coming"><span class="kicker">Under Development</span><h1>${t}</h1><p>${d}</p><div class="badge">تحت التطوير</div></article></section>`)
const contact = () => { const th = state.threads.find((x)=>x.user_id===state.profile?.id); return shell(`<section class="section grid2"><article class="card"><h2>التواصل معنا</h2><div class="chat">${(th?.messages||[]).map((m)=>`<div class="bubble ${m.sender}"><p>${m.text}</p><span>${fmtDate(m.created_at)}</span></div>`).join('') || '<p class="empty">ابدأ أول رسالة.</p>'}</div><form id="user-form" class="msg-row"><input id="user-input" placeholder="اكتب رسالتك هنا..." value="${state.userMsg}"><button class="primary small" ${state.busy?'disabled':''}>إرسال</button></form></article><article class="card"><h3>نبذة عن الدعم</h3><p>كل رسالة تذهب إلى لوحة الأدمن مباشرة، ويمكن الرد عليها من داخل الموقع.</p></article></section>`) }
const admin = () => { const th = state.threads.find((x)=>x.id===state.selectedThreadId) || state.threads[0]; return shell(`<section class="section"><div class="section-head"><span class="kicker">لوحة الأدمن</span><h1 class="title">طلبات السحب والرسائل</h1></div><div class="grid2"><article class="card"><h3>طلبات السحب</h3><div class="list">${state.requests.map((r)=>`<article class="withdraw"><div class="withdraw-top"><strong>${r.user_name}</strong><span class="pill">${statusLabel(r.status)}</span></div><p>المحفظة: ${r.wallet}</p><p>المبلغ: ${fmtCoin(r.amount)}</p><p>رصيد الحساب: ${fmtCoin(r.balance)}</p><div class="action-row"><button class="primary small" data-approve="${r.id}" ${r.status!=='pending'||state.busy?'disabled':''}>تأكيد السحب</button><button class="secondary small" data-reject="${r.id}" ${r.status!=='pending'||state.busy?'disabled':''}>رفض</button></div></article>`).join('') || '<p class="empty">لا توجد طلبات بعد.</p>'}</div></article><article class="card"><h3>رسائل العملاء</h3><div class="thread-list">${state.threads.map((t)=>`<button class="thread ${t.id===state.selectedThreadId?'active':''}" data-thread="${t.id}"><span>${t.user_name}</span><span>${t.status}</span></button>`).join('') || '<p class="empty">لا توجد رسائل بعد.</p>'}</div><div class="chat admin-chat">${(th?.messages||[]).map((m)=>`<div class="bubble ${m.sender}"><p>${m.text}</p><span>${fmtDate(m.created_at)}</span></div>`).join('') || '<p class="empty">اختر محادثة.</p>'}</div><form id="owner-form" class="msg-row"><input id="owner-input" placeholder="اكتب ردك هنا..." value="${state.ownerMsg}"><button class="primary small" ${state.busy?'disabled':''}>إرسال الرد</button></form></article></div></section>`) }

function render() {
  if (state.loading) return void (app.innerHTML = shell(`<section class="section narrow"><article class="coming"><span class="kicker">Loading</span><h1>جارٍ تحميل الموقع</h1><p>نقوم الآن بجلب البيانات من القاعدة.</p></article></section>`))
  app.innerHTML = ({ home, about, signup: () => auth('إنشاء حساب', 'واجهة مبدئية لإنشاء الحساب.'), login: () => auth('تسجيل دخول', 'واجهة مبدئية لتسجيل الدخول.'), dashboard, earn, withdraw, store: () => coming('المتجر الإلكتروني', 'سيظهر لاحقًا مع واجهة المنتجات والطلبات.'), mining: () => coming('تعدين العملة', 'سيظهر لاحقًا كقسم مستقل داخل الموقع.'), contact, admin } as Record<Page, () => string>)[state.page]()
  bind()
}

function bind() {
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((e) => e.onclick = () => { state.page = e.dataset.page as Page; render() })
  document.querySelectorAll<HTMLElement>('[data-task]').forEach((e) => e.onclick = () => void doTask(Number(e.dataset.task)))
  document.querySelector<HTMLInputElement>('#wallet')?.addEventListener('input', (e) => state.wallet = (e.currentTarget as HTMLInputElement).value)
  document.querySelector<HTMLInputElement>('#amount')?.addEventListener('input', (e) => state.amount = (e.currentTarget as HTMLInputElement).value)
  document.querySelector<HTMLButtonElement>('#send-withdraw')?.addEventListener('click', () => void sendWithdraw())
  document.querySelectorAll<HTMLElement>('[data-approve]').forEach((e) => e.onclick = () => void approve(e.dataset.approve || ''))
  document.querySelectorAll<HTMLElement>('[data-reject]').forEach((e) => e.onclick = () => void reject(e.dataset.reject || ''))
  document.querySelectorAll<HTMLElement>('[data-thread]').forEach((e) => e.onclick = () => { state.selectedThreadId = e.dataset.thread || ''; render() })
  document.querySelector<HTMLInputElement>('#user-input')?.addEventListener('input', (e) => state.userMsg = (e.currentTarget as HTMLInputElement).value)
  document.querySelector<HTMLInputElement>('#owner-input')?.addEventListener('input', (e) => state.ownerMsg = (e.currentTarget as HTMLInputElement).value)
  document.querySelector<HTMLFormElement>('#user-form')?.addEventListener('submit', (e) => { e.preventDefault(); void sendUserMessage() })
  document.querySelector<HTMLFormElement>('#owner-form')?.addEventListener('submit', (e) => { e.preventDefault(); void sendOwnerMessage() })
}

boot()
