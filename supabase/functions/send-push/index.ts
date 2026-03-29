import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── VAPID config ──────────────────────────────────
const VAPID_PUBLIC  = 'BElPBDZOr14Ws7bWbZgdSxF2LMc9i4G8VNlU6Mq6X4xtGSJBxfH4QttlALWh-9j1mRVNaSrvpwz273w17uHCMC0'
const VAPID_PRIVATE = 'YfMHwvAodSER39pcU2Taz9PxPFhL6SBDvAR-zre9SZ4'
const VAPID_SUBJECT = 'mailto:admin@fittrack.app'

// ── Encode base64url ──────────────────────────────
function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
}
function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  const b = atob(s.replace(/-/g,'+').replace(/_/g,'/') + pad)
  return Uint8Array.from([...b].map(c => c.charCodeAt(0)))
}

// ── Build VAPID JWT ───────────────────────────────
async function buildVapidJwt(audience: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })))
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    aud: new URL(audience).origin,
    exp: Math.floor(Date.now()/1000) + 12*3600,
    sub: VAPID_SUBJECT
  })))
  const toSign = `${header}.${payload}`
  const privBytes = b64urlDecode(VAPID_PRIVATE)
  const privKey = await crypto.subtle.importKey(
    'raw', privBytes, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name:'ECDSA', hash:'SHA-256' }, privKey, new TextEncoder().encode(toSign)
  ))
  return `${toSign}.${b64url(sig)}`
}

// ── Send one push notification ────────────────────
async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: object) {
  const jwt = await buildVapidJwt(sub.endpoint)
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/octet-stream',
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'TTL': '86400'
    },
    body: JSON.stringify(payload)
  })
  return res.status
}

// ── Main handler ──────────────────────────────────
serve(async (req) => {
  const body = await req.json().catch(() => ({}))
  const { type, record } = body

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let targetUserIds: string[] = []
  let title = ''
  let notifBody = ''
  let tag = 'fittrack'

  // ── Réaction sur une séance ──
  if (type === 'INSERT' && record?.target_user_id && record?.emoji) {
    targetUserIds = [record.target_user_id]
    const { data: prof } = await supabase
      .from('profiles').select('name, email').eq('id', record.user_id).single()
    const name = prof?.name || prof?.email?.split('@')[0] || 'Un ami'
    title = '💬 Nouvelle réaction !'
    notifBody = `${record.emoji} ${name} a réagi à ta séance`
    tag = `reaction-${record.target_user_id}-${record.workout_date}`
  }

  // ── Ami vient de terminer une séance ──
  else if (type === 'INSERT' && record?.user_id && record?.data?.workout) {
    const uid = record.user_id
    const w = record.data.workout
    const { data: friends } = await supabase
      .from('friendships')
      .select('user_id, friend_id')
      .or(`user_id.eq.${uid},friend_id.eq.${uid}`)
      .eq('status', 'accepted')
    targetUserIds = (friends || []).map((f: any) => f.user_id === uid ? f.friend_id : f.user_id)
    const { data: prof } = await supabase
      .from('profiles').select('name, email').eq('id', uid).single()
    const name = prof?.name || prof?.email?.split('@')[0] || 'Un ami'
    title = `${w.emoji || '💪'} Séance terminée !`
    notifBody = `${name} vient de finir : ${w.name || 'une séance'} (${w.duration || '?'} min)`
    tag = `workout-${uid}-${record.date}`
  }

  if (!targetUserIds.length) return new Response('No targets', { status: 200 })

  const { data: subs } = await supabase
    .from('push_subscriptions').select('*').in('user_id', targetUserIds)
  if (!subs?.length) return new Response('No subscriptions', { status: 200 })

  const results = await Promise.allSettled(
    subs.map((s: any) => sendPush(s, { title, body: notifBody, tag, url: '/fittrack/' }))
  )

  // Nettoyer les abonnements expirés (status 410)
  const expired = subs.filter((_: any, i: number) => {
    const r = results[i] as any
    return r.status === 'fulfilled' && r.value === 410
  })
  if (expired.length) {
    await supabase.from('push_subscriptions').delete().in('user_id', expired.map((s: any) => s.user_id))
  }

  const sent = results.filter(r => r.status === 'fulfilled').length
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } })
})
