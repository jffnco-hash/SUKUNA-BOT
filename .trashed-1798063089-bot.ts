import type { HostWASocket, HostBaileysEventMap } from '@oxidezap/baileyrs/host'

type Message = HostBaileysEventMap['messages.upsert']['messages'][number]

const getText = (m: Message): string => {
  const msg = m.message as any
  if (!msg) return ''
  const body = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg
  return String(body.conversation ?? body.extendedTextMessage?.text ??
    body.imageMessage?.caption ?? body.videoMessage?.caption ?? '').trim()
}

const isGroup = (jid: string) => jid.endsWith('@g.us')

// Egyptian phone numbers are stored in international format for comparison.
const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, '')
  if (digits.startsWith('0')) return `20${digits.slice(1)}`
  return digits
}

const DEVELOPERS = new Set([
  '201114030189',
  '201019225118',
  '201038502146'
])

const isDeveloper = (jid: string, phoneNumber?: string) => {
  const candidates = [jid, phoneNumber ?? ''].filter(Boolean).map(value =>
    normalizePhone(value.split('@')[0])
  )
  return candidates.some(value => DEVELOPERS.has(value))
}

const masked = (phone: string) => `+${phone.slice(0, 4)}*******${phone.slice(-2)}`
const keyFor = (group: string, user: string, suffix: string) => `data:${group}:${user}:${suffix}`

export async function handleMessages(
  socket: HostWASocket,
  event: HostBaileysEventMap['messages.upsert'],
  storage: DurableObjectStorage
) {
  if (event.type !== 'notify') return

  for (const m of event.messages) {
    const jid = m.key.remoteJid
    if (!jid || m.key.fromMe || !isGroup(jid)) continue

    const text = getText(m)
    if (!text.startsWith('.')) continue

    const sender = m.key.participant ?? ''
    const commandLine = text.slice(1).trim()
    const [rawCommand, ...args] = commandLine.split(/\s+/)
    const command = (rawCommand ?? '').toLowerCase()
    const meta = await socket.groupMetadata(jid)
    const senderInfo = meta.participants.find(p => p.id === sender)
    const isAdmin = Boolean(senderInfo?.admin)
    const developer = isDeveloper(sender, (senderInfo as any)?.phoneNumber)
    const isBotAdmin = Boolean(meta.participants.find(p => p.id === socket.user?.id)?.admin)
    const mentions = (m.message as any)?.extendedTextMessage?.contextInfo?.mentionedJid ?? []

    const send = async (body: string) => socket.sendMessage(jid, { text: body }, { quoted: m })

    if (command === 'menu' || command === 'help') {
      await send(
`╭━━━『 👹 SUKUNA BOT 』━━━╮
┃ لعنة الملوك | King of Curses
┃ ${developer ? '👑 VERIFIED DEVELOPER' : '⚔️ GROUP MEMBER'}
╰━━━━━━━━━━━━━━━━━━━━━━╯

⚔️ GENERAL
.menu   .help   .ping
.anime  .quote

🪙 ECONOMY
.daily  .balance

🛡️ GROUP ADMIN
.warn @member
.warnings @member
.kick @member
.devs (developer only)

🌐 LANGUAGE: Arabic + English
PREFIX: .

『 SUKUNA — DOMAIN EXPANSION 』`
      )
    } else if (command === 'devs') {
      if (!developer) return void await send('⛔ هذا الأمر للمطورين المعتمدين فقط | Verified developers only.')
      const list = [...DEVELOPERS].map((phone, index) => `${index + 1}. ${masked(phone)}`).join('\n')
      await send(`👑 SUKUNA BOT — VERIFIED DEVELOPERS\n${list}\n\nتم التعرف عليك كمطور معتمد.`)
    } else if (command === 'ping') {
      await send('👹 Sukuna is awake! | سوكونا مستيقظ\n⚡ Pong')
    } else if (command === 'anime') {
      const picks = [
        'Jujutsu Kaisen — Yuji Itadori, Satoru Gojo, Ryomen Sukuna',
        'Attack on Titan — Eren Yeager, Mikasa Ackerman, Levi',
        'Demon Slayer — Tanjiro Kamado, Nezuko, Giyu Tomioka',
        'One Piece — Monkey D. Luffy, Roronoa Zoro, Nami',
        'Naruto — Naruto Uzumaki, Sasuke Uchiha, Kakashi'
      ]
      await send('🎴 Anime random pick:\n' + picks[Math.floor(Math.random() * picks.length)])
    } else if (command === 'quote') {
      await send('👹 “Know your place.”\n— Sukuna Bot')
    } else if (command === 'daily') {
      const key = keyFor(jid, sender, 'lastDaily')
      const today = new Date().toISOString().slice(0, 10)
      if (await storage.get<string>(key) === today) {
        await send('⏳ استلمت مكافأتك اليومية بالفعل. Come back tomorrow!')
      } else {
        const balanceKey = keyFor(jid, sender, 'coins')
        const balance = (await storage.get<number>(balanceKey)) ?? 0
        await storage.put(key, today)
        await storage.put(balanceKey, balance + 100)
        await send('🪙 +100 Sukuna Coins!\nرصيدك الجديد: ' + (balance + 100))
      }
    } else if (command === 'balance') {
      const balance = (await storage.get<number>(keyFor(jid, sender, 'coins'))) ?? 0
      await send(`🪙 رصيدك: ${balance} Sukuna Coins`)
    } else if (command === 'warn') {
      if (!isAdmin && !developer) return void await send('⛔ هذا الأمر للمشرفين أو المطورين فقط | Admins or developers only.')
      if (!mentions.length) return void await send('استخدم: .warn مع منشن العضو')
      const target = String(mentions[0])
      const k = keyFor(jid, target, 'warnings')
      const count = ((await storage.get<number>(k)) ?? 0) + 1
      await storage.put(k, count)
      await send(`⚠️ تم تحذير @${target.split('@')[0]} (${count}/3)`)
      if (count >= 3 && isBotAdmin) {
        await socket.groupParticipantsUpdate(jid, [target], 'remove')
        await storage.put(k, 0)
        await send('🚫 وصل العضو إلى 3 تحذيرات وتمت إزالته.')
      }
    } else if (command === 'warnings') {
      const target = String(mentions[0] ?? sender)
      const count = (await storage.get<number>(keyFor(jid, target, 'warnings'))) ?? 0
      await send(`⚠️ Warnings: ${count}/3`)
    } else if (command === 'kick') {
      if (!isAdmin && !developer) return void await send('⛔ هذا الأمر للمشرفين أو المطورين فقط | Admins or developers only.')
      if (!isBotAdmin) return void await send('⚠️ يجب ترقية البوت إلى مشرف أولاً.')
      if (!mentions.length) return void await send('استخدم: .kick مع منشن العضو')
      await socket.groupParticipantsUpdate(jid, [String(mentions[0])], 'remove')
      await send('👋 تم تنفيذ أمر الإزالة.')
    }
  }
}