import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import './style.css'

type NavKey = 'dashboard' | 'earn' | 'rewards' | 'store' | 'contact' | 'admin'
type TxStatus = 'completed' | 'pending' | 'approved' | 'processing'
type RewardType = 'gift_card' | 'featured_access'
type SupportStatus = 'open' | 'needs_reply' | 'resolved'
type SenderRole = 'user' | 'owner'

type Task = {
  id: number
  title: string
  reward: number
  source: 'video' | 'short_link' | 'daily_bonus'
  cooldown: string
  description: string
}

type Activity = {
  id: string
  title: string
  amount: number
  time: string
  status: TxStatus
}

type RedeemRequest = {
  id: string
  rewardType: RewardType
  title: string
  coinAmount: number
  payoutDetails: string
  status: TxStatus
}

type ChatMessage = {
  id: string
  sender: SenderRole
  text: string
  time: string
}

type ChatThread = {
  id: string
  name: string
  email: string
  status: SupportStatus
  unread: number
  messages: ChatMessage[]
}

type Profile = {
  id: string
  deviceKey: string
  displayName: string
  email: string
  role: 'user' | 'owner'
  coinBalance: number
}

type DbTransaction = {
  id: string
  source: string
  amount: number
  status: TxStatus
  created_at: string
}

type DbRedeemRequest = {
  id: string
  reward_type: RewardType
  coin_amount: number
  payout_details: string
  status: TxStatus
  created_at: string
}

type DbSupportMessage = {
  id: string
  sender_role: SenderRole
  message_text: string
  created_at: string
}

type DbSupportThread = {
  id: string
  status: SupportStatus
  updated_at: string
  profile?: {
    display_name: string | null
    email: string | null
  }[] | null
  support_messages?: DbSupportMessage[] | null
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const OWNER_EMAIL = import.meta.env.VITE_OWNER_EMAIL || 'owner@xcore.app'
const DEVICE_STORAGE_KEY = 'alf-device-key'
const PROFILE_NAME_KEY = 'alf-profile-name'
const PROFILE_EMAIL_KEY = 'alf-profile-email'

const tasks: Task[] = [
  {
    id: 1,
    title: 'مشاهدة إعلان ممول',
    reward: 8,
    source: 'video',
    cooldown: 'جاهز الآن',
    description: 'بعد اكتمال المشاهدة يتم اعتماد المكافأة من جهة السيرفر.',
  },
  {
    id: 2,
    title: 'رابط مختصر',
    reward: 5,
    source: 'short_link',
    cooldown: 'بعد 3 دقائق',
    description: 'فتح الرابط ثم العودة بتوكن صالح يضيف العملة للمحفظة.',
  },
  {
    id: 3,
    title: 'مكافأة يومية',
    reward: 12,
    source: 'daily_bonus',
    cooldown: 'مرة كل 24 ساعة',
    description: 'مكافأة الاحتفاظ اليومية لرفع عودة المستخدم.',
  },
]

const appElement = document.querySelector<HTMLDivElement>('#app')

if (!appElement) {
  throw new Error('App root was not found.')
}

const app = appElement
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null

const state = {
  activeView: 'dashboard' as NavKey,
  loading: true,
  submitting: false,
  error: '',
  success: '',
  aedRate: 0.025,
  dailyCap: 120,
  miningStreak: 6,
  todayEarned: 0,
  totalWithdrawn: 0,
  profile: null as Profile | null,
  activities: [] as Activity[],
  redeemRequests: [] as RedeemRequest[],
  chatThreads: [] as ChatThread[],
  selectedThreadId: '',
  usdtAddress: '',
  userDraftMessage: '',
  ownerDraftMessage: '',
}

let realtimeChannel: RealtimeChannel | null = null

function getOrCreateDeviceKey() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY)
  if (existing) return existing
  const fresh = crypto.randomUUID()
  window.localStorage.setItem(DEVICE_STORAGE_KEY, fresh)
  return fresh
}

function getLocalProfileSeed() {
  const deviceKey = getOrCreateDeviceKey()
  const displayName = window.localStorage.getItem(PROFILE_NAME_KEY) || `User ${deviceKey.slice(0, 6).toUpperCase()}`
  const email = window.localStorage.getItem(PROFILE_EMAIL_KEY) || `${deviceKey.slice(0, 8)}@alf.local`
  window.localStorage.setItem(PROFILE_NAME_KEY, displayName)
  window.localStorage.setItem(PROFILE_EMAIL_KEY, email)
  return { deviceKey, displayName, email }
}

function formatCoins(value: number) {
  return `${Math.abs(value).toLocaleString('en-US')} XC`
}

function formatAed(value: number) {
  return `${value.toFixed(2)} AED`
}

function formatRelativeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ar', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function transactionTitle(source: string) {
  switch (source) {
    case 'video':
      return 'مكافأة مشاهدة فيديو'
    case 'short_link':
      return 'مكافأة رابط مختصر'
    case 'daily_bonus':
      return 'مكافأة يومية'
    case 'redeem':
      return 'طلب استبدال داخلي'
    case 'admin_adjustment':
      return 'تعديل من الإدارة'
    default:
      return 'حركة محفظة'
  }
}

function requestStatusLabel(status: TxStatus) {
  switch (status) {
    case 'completed':
      return 'مكتمل'
    case 'pending':
      return 'معلق'
    case 'approved':
      return 'مقبول'
    case 'processing':
      return 'قيد التنفيذ'
    default:
      return status
  }
}

function threadStatusLabel(status: SupportStatus) {
  switch (status) {
    case 'open':
      return 'مفتوح'
    case 'needs_reply':
      return 'بانتظار الرد'
    case 'resolved':
      return 'تم الرد'
    default:
      return status
  }
}

function getSelectedThread() {
  return state.chatThreads.find((thread) => thread.id === state.selectedThreadId) ?? state.chatThreads[0] ?? null
}

function setNotice(message = '', isError = false) {
  if (isError) {
    state.error = message
    state.success = ''
  } else {
    state.success = message
    state.error = ''
  }
}

async function ensureProfile(client: SupabaseClient) {
  const seed = getLocalProfileSeed()
  const { data, error } = await client
    .from('profiles')
    .upsert(
      {
        device_key: seed.deviceKey,
        display_name: seed.displayName,
        email: seed.email,
        role: 'user',
      },
      { onConflict: 'device_key' },
    )
    .select('id, device_key, display_name, email, role, coin_balance')
    .single()

  if (error) throw error

  state.profile = {
    id: data.id,
    deviceKey: data.device_key,
    displayName: data.display_name ?? seed.displayName,
    email: data.email ?? seed.email,
    role: data.role,
    coinBalance: data.coin_balance,
  }
}

function mapTransactions(items: DbTransaction[]) {
  return items.map((item) => ({
    id: item.id,
    title: transactionTitle(item.source),
    amount: item.amount,
    status: item.status,
    time: formatRelativeTime(item.created_at),
  }))
}

function mapRedeemRequests(items: DbRedeemRequest[]) {
  return items.map((item) => ({
    id: item.id,
    rewardType: item.reward_type,
    title: item.reward_type === 'gift_card' ? 'بطاقة رقمية' : 'مزايا خاصة',
    coinAmount: item.coin_amount,
    payoutDetails: item.payout_details ?? '',
    status: item.status,
  }))
}

function mapThreads(items: DbSupportThread[]) {
  return items.map((item) => ({
    id: item.id,
    name: item.profile?.[0]?.display_name || 'مستخدم بدون اسم',
    email: item.profile?.[0]?.email || 'no-email@alf.local',
    status: item.status,
    unread: item.status === 'needs_reply' ? 1 : 0,
    messages: (item.support_messages ?? []).map((message) => ({
      id: message.id,
      sender: message.sender_role,
      text: message.message_text,
      time: formatRelativeTime(message.created_at),
    })),
  }))
}

async function loadRemoteState() {
  if (!supabase || !state.profile) return

  const userId = state.profile.id
  const [profileResult, txResult, redeemResult, threadsResult, userThreadResult] = await Promise.all([
    supabase.from('profiles').select('coin_balance').eq('id', userId).single(),
    supabase
      .from('wallet_transactions')
      .select('id, source, amount, status, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('redeem_requests')
      .select('id, reward_type, coin_amount, payout_details, status, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase
      .from('support_threads')
      .select(`
        id,
        status,
        updated_at,
        profile:profiles!support_threads_user_id_fkey(display_name,email),
        support_messages(id,sender_role,message_text,created_at)
      `)
      .order('updated_at', { ascending: false }),
    supabase.from('support_threads').select('id').eq('user_id', userId).limit(1),
  ])

  if (profileResult.error) throw profileResult.error
  if (txResult.error) throw txResult.error
  if (redeemResult.error) throw redeemResult.error
  if (threadsResult.error) throw threadsResult.error
  if (userThreadResult.error) throw userThreadResult.error

  state.profile.coinBalance = profileResult.data.coin_balance
  state.activities = mapTransactions(txResult.data as DbTransaction[])
  state.redeemRequests = mapRedeemRequests(redeemResult.data as DbRedeemRequest[])
  state.chatThreads = mapThreads(threadsResult.data as DbSupportThread[])
  state.selectedThreadId = state.selectedThreadId || userThreadResult.data?.[0]?.id || state.chatThreads[0]?.id || ''
  state.todayEarned = state.activities.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0)
  state.totalWithdrawn = state.redeemRequests.reduce((sum, item) => sum + item.coinAmount, 0)
}

function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : 'حدث خطأ غير متوقع.'
  setNotice(message, true)
  state.loading = false
  state.submitting = false
  renderApp()
}

function subscribeToRealtime() {
  if (!supabase || !state.profile) return

  realtimeChannel?.unsubscribe()
  realtimeChannel = supabase
    .channel(`alf-live-${state.profile.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_transactions' }, () => {
      void loadRemoteState().then(renderApp).catch(handleError)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'redeem_requests' }, () => {
      void loadRemoteState().then(renderApp).catch(handleError)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'support_threads' }, () => {
      void loadRemoteState().then(renderApp).catch(handleError)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'support_messages' }, () => {
      void loadRemoteState().then(renderApp).catch(handleError)
    })
    .subscribe()
}

async function bootstrap() {
  try {
    if (!supabase) {
      setNotice('أضف بيانات Supabase في ملف البيئة ثم أعد التشغيل.', true)
      state.loading = false
      renderApp()
      return
    }

    await ensureProfile(supabase)
    await loadRemoteState()
    subscribeToRealtime()
    state.loading = false
    renderApp()
  } catch (error) {
    handleError(error)
  }
}

async function createThreadIfMissing() {
  if (!supabase || !state.profile) return ''
  const current = state.chatThreads.find((thread) => thread.email === state.profile?.email)
  if (current) return current.id

  const { data, error } = await supabase
    .from('support_threads')
    .insert({
      user_id: state.profile.id,
      status: 'open',
      subject: 'Live Support Chat',
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

async function handleEarn(taskId: number) {
  if (!supabase || !state.profile || state.submitting) return
  const task = tasks.find((item) => item.id === taskId)
  if (!task) return

  state.submitting = true
  setNotice('')
  renderApp()

  try {
    const { error } = await supabase.from('wallet_transactions').insert({
      user_id: state.profile.id,
      source: task.source,
      amount: task.reward,
      status: 'completed',
      notes: task.title,
    })

    if (error) throw error

    setNotice(`تمت إضافة ${task.reward} XC إلى المحفظة.`)
    state.activeView = 'dashboard'
    await loadRemoteState()
  } catch (error) {
    handleError(error)
    return
  }

  state.submitting = false
  renderApp()
}

async function handleRewardRedeem() {
  if (!supabase || !state.profile || state.submitting) return

  const rewardLabel = state.usdtAddress.trim()
  if (!rewardLabel) {
    setNotice('اكتب اسم المكافأة التي تريد طلبها أولاً.', true)
    renderApp()
    return
  }

  state.submitting = true
  setNotice('')
  renderApp()

  try {
    const { error: requestError } = await supabase.from('redeem_requests').insert({
      user_id: state.profile.id,
      reward_type: 'featured_access',
      coin_amount: 500,
      payout_details: rewardLabel,
      status: 'pending',
    })

    if (requestError) throw requestError

    const { error: txError } = await supabase.from('wallet_transactions').insert({
      user_id: state.profile.id,
      source: 'redeem',
      amount: -500,
      status: 'pending',
      notes: `Reward redeem request: ${rewardLabel}`,
    })

    if (txError) throw txError

    state.usdtAddress = ''
    setNotice('تم إنشاء طلب المكافأة وإرساله للإدارة.')
    await loadRemoteState()
  } catch (error) {
    handleError(error)
    return
  }

  state.submitting = false
  renderApp()
}

async function submitUserMessage() {
  if (!supabase || !state.profile || state.submitting) return

  const message = state.userDraftMessage.trim()
  if (!message) return

  state.submitting = true
  setNotice('')
  renderApp()

  try {
    const threadId = await createThreadIfMissing()
    const { error: messageError } = await supabase.from('support_messages').insert({
      thread_id: threadId,
      sender_role: 'user',
      message_text: message,
    })

    if (messageError) throw messageError

    const { error: threadError } = await supabase
      .from('support_threads')
      .update({ status: 'needs_reply', updated_at: new Date().toISOString() })
      .eq('id', threadId)

    if (threadError) throw threadError

    state.userDraftMessage = ''
    setNotice('تم إرسال الرسالة للمالك.')
    await loadRemoteState()
    state.activeView = 'contact'
  } catch (error) {
    handleError(error)
    return
  }

  state.submitting = false
  renderApp()
}

async function submitOwnerReply() {
  if (!supabase || state.submitting) return

  const thread = getSelectedThread()
  const reply = state.ownerDraftMessage.trim()
  if (!thread || !reply) return

  state.submitting = true
  setNotice('')
  renderApp()

  try {
    const { error: messageError } = await supabase.from('support_messages').insert({
      thread_id: thread.id,
      sender_role: 'owner',
      message_text: reply,
    })

    if (messageError) throw messageError

    const { error: threadError } = await supabase
      .from('support_threads')
      .update({ status: 'resolved', updated_at: new Date().toISOString() })
      .eq('id', thread.id)

    if (threadError) throw threadError

    state.ownerDraftMessage = ''
    setNotice('تم إرسال الرد من لوحة المالك.')
    await loadRemoteState()
  } catch (error) {
    handleError(error)
    return
  }

  state.submitting = false
  renderApp()
}

function renderNotice() {
  if (state.error) return `<div class="notice notice-error">${state.error}</div>`
  if (state.success) return `<div class="notice notice-success">${state.success}</div>`
  return ''
}

function renderOverview() {
  const balance = state.profile?.coinBalance ?? 0
  const recentActivity = state.activities.map((activity) => `
    <article class="list-row">
      <div>
        <strong>${activity.title}</strong>
        <p>${activity.time}</p>
      </div>
      <div class="row-end">
        <span class="${activity.amount >= 0 ? 'amount-positive' : 'amount-negative'}">
          ${activity.amount >= 0 ? '+' : '-'}${formatCoins(activity.amount)}
        </span>
        <span class="badge">${requestStatusLabel(activity.status)}</span>
      </div>
    </article>
  `).join('')

  return `
    <section class="view-grid hero-grid">
      <article class="card wallet-card">
        <p class="eyebrow">Wallet Balance</p>
        <h2>${balance.toLocaleString('en-US')} XC</h2>
        <p class="muted">القيمة التقريبية: ${formatAed(balance * state.aedRate)}</p>
        <div class="pill-row">
          <span class="pill">الحد اليومي: ${state.dailyCap} XC</span>
          <span class="pill">الاستمرارية: ${state.miningStreak} أيام</span>
        </div>
      </article>
      <article class="card stats-card">
        <div class="mini-stat">
          <span>أرباح هذا التشغيل</span>
          <strong>${state.todayEarned} XC</strong>
        </div>
        <div class="mini-stat">
          <span>إجمالي طلبات المكافآت</span>
          <strong>${state.totalWithdrawn} XC</strong>
        </div>
        <div class="mini-stat">
          <span>طلبات مفتوحة</span>
          <strong>${state.redeemRequests.length}</strong>
        </div>
      </article>
    </section>

    <section class="view-grid two-columns">
      <article class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Quick Actions</p>
            <h3>مركز الربح السريع</h3>
          </div>
          <button class="ghost-button" data-nav="earn">ابدأ الآن</button>
        </div>
        <div class="task-grid">
          ${tasks.slice(0, 2).map((task) => `
            <div class="task-card">
              <strong>${task.title}</strong>
              <p>${task.description}</p>
              <div class="task-meta">
                <span>+${task.reward} XC</span>
                <span>${task.cooldown}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </article>
      <article class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Recent Activity</p>
            <h3>آخر الحركات</h3>
          </div>
        </div>
        <div class="stack-list">${recentActivity || '<p class="muted">لا توجد حركات بعد.</p>'}</div>
      </article>
    </section>
  `
}

function renderEarn() {
  return `
    <section class="view-grid single-column">
      <article class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Earning Hub</p>
            <h3>المهام ومكافآت العملة</h3>
          </div>
          <span class="pill">المنطق الحالي يسجل المكافأة مباشرة في قاعدة البيانات</span>
        </div>
        <div class="task-grid">
          ${tasks.map((task) => `
            <div class="task-card">
              <div class="task-top">
                <strong>${task.title}</strong>
                <span class="task-reward">+${task.reward} XC</span>
              </div>
              <p>${task.description}</p>
              <div class="task-meta">
                <span>${task.cooldown}</span>
                <button class="action-button" data-action="earn" data-id="${task.id}" ${state.submitting ? 'disabled' : ''}>
                  ${state.submitting ? 'جارٍ التنفيذ...' : 'تنفيذ المهمة'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </article>
    </section>
  `
}

function renderRedeem() {
  return `
    <section class="view-grid two-columns">
      <article class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Internal Rewards</p>
            <h3>استبدال النقاط بمكافآت داخلية</h3>
          </div>
          <span class="pill">500 XC لكل طلب</span>
        </div>
        <div class="task-card">
          <strong>طلب مكافأة أو ميزة خاصة</strong>
          <p>اكتب اسم المكافأة التي تريدها مثل بطاقة رقمية أو وصول خاص، وسيظهر الطلب مباشرة في لوحة المالك.</p>
          <div class="form-grid">
            <input id="usdt-address-input" type="text" placeholder="مثال: بطاقة رقمية أو عضوية مميزة" value="${state.usdtAddress}" />
            <button id="usdt-submit-button" class="action-button" ${state.submitting ? 'disabled' : ''}>
              ${state.submitting ? 'جارٍ الإرسال...' : 'إرسال طلب المكافأة'}
            </button>
          </div>
        </div>
        <div class="task-card disabled-card">
          <strong>المتجر الكامل</strong>
          <p>سيتم تشغيله لاحقًا بعد إثبات الاستخدام واستقرار منطق النقاط.</p>
        </div>
      </article>
      <article class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Requests</p>
            <h3>طلبات المكافآت الحالية</h3>
          </div>
        </div>
        <div class="stack-list">
          ${state.redeemRequests.length
            ? state.redeemRequests.map((request) => `
                <article class="list-row">
                  <div>
                    <strong>${request.title}</strong>
                    <p>${request.payoutDetails || 'بدون تفاصيل إضافية'}</p>
                  </div>
                  <div class="row-end">
                    <span class="amount-negative">-${formatCoins(request.coinAmount)}</span>
                    <span class="badge">${requestStatusLabel(request.status)}</span>
                  </div>
                </article>
              `).join('')
            : '<p class="muted">لا توجد طلبات مكافآت بعد.</p>'}
        </div>
      </article>
    </section>
  `
}

function renderStore() {
  return `
    <section class="view-grid single-column">
      <article class="card store-card">
        <p class="eyebrow">Marketplace</p>
        <h3>المتجر قادم قريبًا</h3>
        <p class="muted">واجهة المتجر جاهزة بصريًا فقط، والتشغيل الفعلي مؤجل للمرحلة القادمة.</p>
        <div class="coming-soon">انتظر قريبًا</div>
      </article>
    </section>
  `
}

function renderContact() {
  const selectedThread = getSelectedThread()
  const messages = selectedThread?.messages ?? []

  return `
    <section class="view-grid contact-layout">
      <article class="card chat-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Contact Owner</p>
            <h3>تواصل معنا</h3>
          </div>
          <span class="badge">رد مباشر من المالك</span>
        </div>
        <div class="chat-window">
          ${messages.length
            ? messages.map((message) => `
                <div class="bubble ${message.sender === 'owner' ? 'owner' : 'user'}">
                  <p>${message.text}</p>
                  <span>${message.time}</span>
                </div>
              `).join('')
            : '<p class="muted">ابدأ أول رسالة وسيتم إنشاء المحادثة تلقائيًا.</p>'}
        </div>
        <form id="user-chat-form" class="message-form">
          <input id="user-chat-input" name="message" type="text" placeholder="اكتب رسالتك هنا..." value="${state.userDraftMessage}" required />
          <button type="submit" class="action-button" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'جارٍ الإرسال...' : 'إرسال'}</button>
        </form>
      </article>
      <article class="card help-card">
        <p class="eyebrow">Support Notes</p>
        <h3>الحالة الحالية للدعم</h3>
        <ul class="flat-list">
          <li>الرسائل تحفظ في <code>support_messages</code>.</li>
          <li>كل محادثة تحدث حالة <code>support_threads</code>.</li>
          <li>لوحة المالك تعرض الرسائل وتسمح بالرد عليها الآن.</li>
        </ul>
      </article>
    </section>
  `
}

function renderAdmin() {
  const selectedThread = getSelectedThread()

  return `
    <section class="view-grid admin-layout">
      <article class="card admin-summary">
        <div class="mini-stat">
          <span>المستخدم الحالي</span>
          <strong>${state.profile?.displayName ?? 'غير معروف'}</strong>
        </div>
        <div class="mini-stat">
          <span>رسائل تحتاج رد</span>
          <strong>${state.chatThreads.filter((thread) => thread.status === 'needs_reply').length}</strong>
        </div>
        <div class="mini-stat">
          <span>طلبات المكافآت</span>
          <strong>${state.redeemRequests.length}</strong>
        </div>
      </article>
      <article class="card thread-list-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Inbox</p>
            <h3>رسائل العملاء</h3>
          </div>
        </div>
        <div class="thread-list">
          ${state.chatThreads.length
            ? state.chatThreads.map((thread) => `
                <button class="thread-item ${thread.id === state.selectedThreadId ? 'active' : ''}" data-thread-id="${thread.id}">
                  <div>
                    <strong>${thread.name}</strong>
                    <p>${thread.email}</p>
                  </div>
                  <div class="row-end">
                    <span class="badge">${threadStatusLabel(thread.status)}</span>
                    ${thread.unread ? `<span class="counter-pill">${thread.unread}</span>` : ''}
                  </div>
                </button>
              `).join('')
            : '<p class="muted">لا توجد محادثات بعد.</p>'}
        </div>
      </article>
      <article class="card thread-view-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Live Conversation</p>
            <h3>${selectedThread?.name ?? 'لا توجد محادثة'}</h3>
          </div>
          <span class="pill">${OWNER_EMAIL}</span>
        </div>
        <div class="chat-window admin-chat">
          ${selectedThread?.messages?.length
            ? selectedThread.messages.map((message) => `
                <div class="bubble ${message.sender === 'owner' ? 'owner' : 'user'}">
                  <p>${message.text}</p>
                  <span>${message.time}</span>
                </div>
              `).join('')
            : '<p class="muted">اختر محادثة لعرضها هنا.</p>'}
        </div>
        <form id="admin-reply-form" class="message-form">
          <input id="admin-reply-input" name="reply" type="text" placeholder="اكتب رد المالك..." value="${state.ownerDraftMessage}" required />
          <button type="submit" class="action-button" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'جارٍ الإرسال...' : 'إرسال الرد'}</button>
        </form>
      </article>
    </section>
  `
}

function renderLoading() {
  return `
    <section class="view-grid single-column">
      <article class="card store-card">
        <p class="eyebrow">Loading</p>
        <h3>جارٍ ربط المشروع مع قاعدة البيانات</h3>
        <p class="muted">نحمّل المحفظة، الرسائل، وطلبات المكافآت من Supabase.</p>
      </article>
    </section>
  `
}

function renderView() {
  if (state.loading) return renderLoading()
  switch (state.activeView) {
    case 'dashboard':
      return renderOverview()
    case 'earn':
      return renderEarn()
    case 'rewards':
      return renderRedeem()
    case 'store':
      return renderStore()
    case 'contact':
      return renderContact()
    case 'admin':
      return renderAdmin()
    default:
      return renderOverview()
  }
}

function renderApp() {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-block">
          <span class="brand-mark">XC</span>
          <div>
            <strong>X-Coin Core</strong>
            <p>Supabase MVP</p>
          </div>
        </div>
        <nav class="nav-list">
          ${[
            ['dashboard', 'الرئيسية'],
            ['earn', 'الربح'],
            ['rewards', 'المكافآت'],
            ['store', 'المتجر'],
            ['contact', 'تواصل معنا'],
            ['admin', 'لوحة المالك'],
          ].map(([key, label]) => `
            <button class="nav-item ${state.activeView === key ? 'active' : ''}" data-nav="${key}">
              ${label}
            </button>
          `).join('')}
        </nav>
        <div class="sidebar-note">
          <p>الحساب الحالي: <strong>${state.profile?.displayName ?? 'جارٍ التحميل...'}</strong></p>
          <p>البريد المحلي: ${state.profile?.email ?? 'جارٍ التحميل...'}</p>
        </div>
      </aside>
      <main class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">Hybrid Rewards Platform</p>
            <h1>الربح والمكافآت والدردشة الحية</h1>
          </div>
          <div class="topbar-meta">
            <span class="pill">رصيد المستخدم: ${state.profile?.coinBalance ?? 0} XC</span>
            <span class="pill">حساب المالك: ${OWNER_EMAIL}</span>
          </div>
        </header>
        ${renderNotice()}
        ${renderView()}
      </main>
    </div>
  `

  bindEvents()
}

function bindEvents() {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((element) => {
    element.addEventListener('click', () => {
      state.activeView = element.dataset.nav as NavKey
      renderApp()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-action="earn"]').forEach((element) => {
    element.addEventListener('click', () => {
      void handleEarn(Number(element.dataset.id))
    })
  })

  document.querySelectorAll<HTMLElement>('[data-thread-id]').forEach((element) => {
    element.addEventListener('click', () => {
      state.selectedThreadId = element.dataset.threadId || ''
      renderApp()
    })
  })

  document.querySelector<HTMLInputElement>('#usdt-address-input')?.addEventListener('input', (event) => {
    state.usdtAddress = (event.currentTarget as HTMLInputElement).value
  })

  document.querySelector<HTMLButtonElement>('#usdt-submit-button')?.addEventListener('click', () => {
    void handleRewardRedeem()
  })

  document.querySelector<HTMLInputElement>('#user-chat-input')?.addEventListener('input', (event) => {
    state.userDraftMessage = (event.currentTarget as HTMLInputElement).value
  })

  document.querySelector<HTMLInputElement>('#admin-reply-input')?.addEventListener('input', (event) => {
    state.ownerDraftMessage = (event.currentTarget as HTMLInputElement).value
  })

  document.querySelector<HTMLFormElement>('#user-chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitUserMessage()
  })

  document.querySelector<HTMLFormElement>('#admin-reply-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitOwnerReply()
  })
}

renderApp()
void bootstrap()
