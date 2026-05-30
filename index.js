require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'convidesk123';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] SUPABASE_URL or SUPABASE_KEY missing!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function log(tag, msg, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data || '');
}

// ─── RESOLVE USER ID ──────────────────────────────────────────────────────────
async function resolveUserId() {
  const { data, error } = await supabase
    .from('businesses')
    .select('user_id')
    .limit(1)
    .maybeSingle();

  if (error) log('RESOLVE_ERR', error.message);
  log('RESOLVE', `userId = ${data?.user_id || 'NULL — businesses table empty!'}`);
  return data?.user_id || null;
}

// ─── UPSERT CONVERSATION ──────────────────────────────────────────────────────
async function upsertConversation(userId, customerPhone, customerName, lastMessage, status, tag) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, unread_count')
    .eq('user_id', userId)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    await supabase.from('conversations').update({
      last_message: lastMessage, status, tag: tag || null,
      unread_count: (existing.unread_count || 0) + 1, updated_at: now,
    }).eq('id', existing.id);
    return existing.id;
  }

  const { data: newConv } = await supabase.from('conversations').insert({
    user_id: userId, customer_phone: customerPhone,
    customer_name: customerName || customerPhone,
    last_message: lastMessage, status, tag: tag || null,
    unread_count: 1, created_at: now, updated_at: now,
  }).select('id').single();

  return newConv?.id || null;
}

// ─── SAVE MESSAGE ─────────────────────────────────────────────────────────────
async function saveMessage(userId, conversationId, customerPhone, text, sender) {
  const { error } = await supabase.from('messages').insert({
    user_id: userId, conversation_id: conversationId,
    customer_phone: customerPhone, body: text, sender,
    created_at: new Date().toISOString(),
  });
  if (error) log('MSG_SAVE_ERR', error.message);
}

// ─── LEAD SCORING ─────────────────────────────────────────────────────────────
function calculateLeadScore(text) {
  const t = text.toLowerCase();
  let score = 0;
  ['bulk','wholesale','order','buy','purchase','distributor','dealer'].forEach(k => { if (t.includes(k)) score += 25; });
  ['price','rate','cost','kitna','how much','minimum','quantity','delivery'].forEach(k => { if (t.includes(k)) score += 15; });
  ['interested','info','details','catalogue','catalog','list'].forEach(k => { if (t.includes(k)) score += 8; });
  return Math.min(score, 99);
}

function detectLeadType(text) {
  const t = text.toLowerCase();
  if (t.includes('bulk') || t.includes('wholesale')) return 'Bulk Order Inquiry';
  if (t.includes('distributor') || t.includes('dealer')) return 'Distributorship Interest';
  if (t.includes('price') || t.includes('rate') || t.includes('kitna')) return 'Pricing Inquiry';
  if (t.includes('delivery')) return 'Delivery Inquiry';
  if (t.includes('order')) return 'Order Inquiry';
  if (t.includes('stock') || t.includes('available')) return 'Stock Inquiry';
  return 'General Inquiry';
}

// ─── CAPTURE LEAD ─────────────────────────────────────────────────────────────
async function captureLead(userId, customerPhone, customerName, inquiryType, score) {
  const { data: existing } = await supabase.from('leads')
    .select('id, lead_score').eq('user_id', userId).eq('customer_phone', customerPhone).maybeSingle();

  if (existing) {
    if (score > (existing.lead_score || 0)) {
      await supabase.from('leads').update({ lead_score: score, inquiry_type: inquiryType, updated_at: new Date().toISOString() }).eq('id', existing.id);
    }
  } else {
    await supabase.from('leads').insert({
      user_id: userId, customer_phone: customerPhone,
      customer_name: customerName || customerPhone,
      inquiry_type: inquiryType, lead_score: score,
      created_at: new Date().toISOString(),
    });
    log('LEAD', `Captured: ${customerPhone} | ${inquiryType} | Score: ${score}`);
  }
}

// ─── HUMAN TAKEOVER ───────────────────────────────────────────────────────────
function needsHumanTakeover(text) {
  const t = text.toLowerCase();
  return ['speak to human','speak to agent','human agent','manager chahiye','agent chahiye','complaint karna hai','fraud hua','cheated','wrong item mila','damaged item'].some(k => t.includes(k));
}

// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, message, phoneNumberId) {
  const pid = phoneNumberId || PHONE_NUMBER_ID;

  log('WA_SEND_TRY', `to=${to} | pid=${pid} | token=${WA_TOKEN ? WA_TOKEN.slice(0,20)+'...' : 'MISSING'}`);

  if (!WA_TOKEN) { log('WA_ERR', '❌ WA_TOKEN missing in .env'); return; }
  if (!pid)      { log('WA_ERR', '❌ PHONE_NUMBER_ID missing in .env'); return; }

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${pid}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: message, preview_url: false } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    log('WA_SEND', `✅ Sent to ${to} | msgId: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    const meta = err.response?.data?.error;
    log('WA_ERR', `❌ FAILED to ${to}`);
    log('WA_ERR', `code=${meta?.code} | msg=${meta?.message || err.message}`);
    log('WA_ERR', `full error: ${JSON.stringify(err.response?.data || {})}`);
    if (meta?.code === 190)    log('WA_FIX', '→ WA_TOKEN expired — get new 24hr token from Meta Console');
    if (meta?.code === 100)    log('WA_FIX', '→ PHONE_NUMBER_ID wrong — check Meta Console');
    if (meta?.code === 131030) log('WA_FIX', '→ 24hr window closed — customer must message first');
    if (meta?.code === 131047) log('WA_FIX', '→ Message outside 24hr window — use template');
  }
}

// ─── CORE AI REPLY ────────────────────────────────────────────────────────────
async function getReply(userId, text) {
  const t = text.toLowerCase().trim();
  log('REPLY', `Processing: "${text}" | userId: ${userId}`);

  // ── 1. Knowledge Base ─────────────────────────────────────────────────────
  const { data: kbItems, error: kbErr } = await supabase
    .from('knowledge_base')
    .select('title, content, keywords, is_active')

  if (kbErr) log('KB_ERR', kbErr.message);
  log('KB', `Fetched ${kbItems?.length || 0} total KB entries`);

  if (kbItems && kbItems.length > 0) {
    // Only active entries
    const activeKB = kbItems.filter(kb => kb.is_active !== false);
    log('KB', `Active entries: ${activeKB.length}`);

    for (const kb of activeKB) {
      const kwList = kb.keywords
        ? kb.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : [kb.title?.toLowerCase()].filter(Boolean);

      log('KB_CHECK', `"${kb.title}" | keywords: [${kwList.join(', ')}]`);
      const matched = kwList.some(kw => kw && t.includes(kw));

      if (matched && kb.content) {
        log('KB_MATCH', `✅ Matched: "${kb.title}"`);
        return { reply: kb.content, tag: 'AI Replied', status: 'ai' };
      }
    }
    log('KB', 'No KB match found');
  }

  // ── 2. Auto Reply Rules ───────────────────────────────────────────────────
  const { data: rules, error: rulesErr } = await supabase
    .from('auto_reply_rules')
    .select('keyword, reply, is_active')
    .eq('user_id', userId)

  if (rulesErr) log('RULES_ERR', rulesErr.message);
  log('RULES', `Fetched ${rules?.length || 0} auto reply rules`);

  if (rules && rules.length > 0) {
    const activeRules = rules.filter(r => r.is_active !== false);
    for (const rule of activeRules) {
      const kw = rule.keyword?.toLowerCase().trim();
      if (kw && t.includes(kw)) {
        log('RULES_MATCH', `✅ Matched keyword: "${kw}"`);
        return { reply: rule.reply, tag: 'AI Replied', status: 'ai' };
      }
    }
    log('RULES', 'No rule match found');
  }

  // ── 3. Price / Stock ──────────────────────────────────────────────────────
  const isPriceQ = /price|rate|kitna|cost|kya hai|btao|how much|product list|catalogue|catalog/.test(t);
  const isStockQ = /stock|available|hai kya|milega|in stock/.test(t);

  if (isPriceQ || isStockQ) {
    const { data: products } = await supabase.from('products').select('name, price, stock, category').eq('user_id', userId);
    log('PRODUCTS', `Fetched ${products?.length || 0} products`);

    if (products && products.length > 0) {
      const specific = products.find(p => t.includes(p.name.toLowerCase()));
      if (specific) {
        return {
          reply: `*${specific.name}*\n💰 Price: ₹${specific.price?.toLocaleString('en-IN')}\n📦 Stock: ${(specific.stock || 0) > 0 ? `✅ ${specific.stock} units` : '❌ Out of stock'}`,
          tag: 'Lead Captured', status: 'ai',
        };
      }

      if (isPriceQ) {
        const byCat = products.reduce((acc, p) => {
          const cat = p.category || 'Products';
          if (!acc[cat]) acc[cat] = [];
          acc[cat].push(p);
          return acc;
        }, {});
        let reply = '📋 *Hamare Products ki Price List:*\n\n';
        for (const [cat, items] of Object.entries(byCat)) {
          if (Object.keys(byCat).length > 1) reply += `*${cat}*\n`;
          items.forEach(p => { reply += `• ${p.name}: ₹${p.price?.toLocaleString('en-IN')}\n`; });
          reply += '\n';
        }
        reply += '📞 Bulk order ya special rate ke liye directly contact karein!';
        return { reply: reply.trim(), tag: 'Lead Captured', status: 'ai' };
      }

      if (isStockQ) {
        let reply = '📦 *Stock Availability:*\n\n';
        products.forEach(p => { reply += `• *${p.name}*: ${(p.stock || 0) > 0 ? `✅ ${p.stock} units` : '❌ Out of stock'}\n`; });
        return { reply: reply.trim(), tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // ── 4. Greetings ──────────────────────────────────────────────────────────
  if (/^(hi|hello|hey|helo|hii|assalam|salam|namaste|namaskar|hy|hye)/.test(t)) {
    return {
      reply: '👋 *Aadab!* Hamare store mein aapka swagat hai!\n\nHum aapki kaise madad kar sakte hain?\n\n• 📦 Price list: *price*\n• 📋 Stock check: *stock*\n• 🛒 Order karna: *order*\n• 📞 Agent: *agent chahiye*',
      tag: 'AI Replied', status: 'ai',
    };
  }

  // ── 5. Order ──────────────────────────────────────────────────────────────
  if (/order|book|kharidna|lena|chahiye/.test(t)) {
    return {
      reply: '🛒 Order karne ke liye batayein:\n\n1️⃣ Product ka naam\n2️⃣ Quantity\n3️⃣ Delivery address\n\nHum jald confirm karenge! ✅',
      tag: 'Lead Captured', status: 'ai',
    };
  }

  // ── 6. Location ───────────────────────────────────────────────────────────
  if (/address|location|kahan|where|shop|store|office/.test(t)) {
    const { data: biz } = await supabase.from('businesses').select('address, city').eq('user_id', userId).maybeSingle();
    if (biz?.address) return { reply: `📍 *Hamara Address:*\n${biz.address}${biz.city ? ', ' + biz.city : ''}`, tag: 'AI Replied', status: 'ai' };
  }

  // ── 7. Timing ─────────────────────────────────────────────────────────────
  if (/time|timing|open|close|hours|baje|kab/.test(t)) {
    const { data: biz } = await supabase.from('businesses').select('business_hours').eq('user_id', userId).maybeSingle();
    if (biz?.business_hours) return { reply: `⏰ *Business Hours:*\n${biz.business_hours}`, tag: 'AI Replied', status: 'ai' };
  }

  // ── 8. Fallback ───────────────────────────────────────────────────────────
  log('REPLY', 'Using fallback response');
  return {
    reply: 'Shukriya message karne ke liye! 🙏\nAapki query note kar li gayi hai. Hamare agent jald sampark karenge.\n\nIn options try karein:\n• *price* — Price list\n• *stock* — Stock check\n• *order* — Order karna',
    tag: 'AI Replied', status: 'ai',
  };
}

// ─── WEBHOOK VERIFY ───────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('WEBHOOK', 'Verified ✅');
    return res.status(200).send(challenge);
  }
  log('WEBHOOK', 'Verification failed ❌');
  res.sendStatus(403);
});

// ─── WEBHOOK RECEIVE ──────────────────────────────────────────────────────────
const processedMsgs = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;
    if (value.statuses) return;

    const message = value.messages?.[0];
    if (!message) return;

    if (processedMsgs.has(message.id)) { log('DEDUP', `Skipped: ${message.id}`); return; }
    processedMsgs.add(message.id);
    setTimeout(() => processedMsgs.delete(message.id), 10 * 60 * 1000);

    const customerPhone = message.from;
    const customerName  = value.contacts?.[0]?.profile?.name || customerPhone;
    const phoneNumberId = value.metadata?.phone_number_id;
    const msgType       = message.type;

    log('IN', `From: ${customerPhone} | Name: ${customerName} | Type: ${msgType}`);

    if (msgType !== 'text') {
      await sendWhatsAppMessage(customerPhone, 'Filhaal hum sirf text messages handle kar sakte hain. 🙏', phoneNumberId);
      return;
    }

    const text = message.text?.body?.trim();
    if (!text) return;
    log('IN_TEXT', `"${text}"`);

    const userId = await resolveUserId();
    if (!userId) {
      log('WARN', '❌ No userId — businesses table empty! Add a row to businesses table.');
      return;
    }

    if (needsHumanTakeover(text)) {
      log('TAKEOVER', `Escalating: ${customerPhone}`);
      const convId = await upsertConversation(userId, customerPhone, customerName, text, 'human', 'Human Takeover');
      await saveMessage(userId, convId, customerPhone, text, 'customer');
      await sendWhatsAppMessage(customerPhone, '🙏 Hamare agent jald aapse sampark karenge. ConviDesk Team', phoneNumberId);
      return;
    }

    const leadScore = calculateLeadScore(text);
    const leadType  = detectLeadType(text);
    if (leadScore >= 25) await captureLead(userId, customerPhone, customerName, leadType, leadScore);

    const { reply, tag, status } = await getReply(userId, text);
    log('REPLY_READY', `tag=${tag} | reply="${reply.slice(0, 60)}..."`);

    const convId = await upsertConversation(userId, customerPhone, customerName, text, status, tag);
    await saveMessage(userId, convId, customerPhone, text, 'customer');
    await saveMessage(userId, convId, customerPhone, reply, 'bot');

    await sendWhatsAppMessage(customerPhone, reply, phoneNumberId);
    log('DONE', `✅ Replied to ${customerPhone} | tag: ${tag} | score: ${leadScore}`);

  } catch (err) {
    log('ERROR', `Webhook error: ${err.message}`);
    console.error(err);
  }
});

// ─── DEBUG ENDPOINT ───────────────────────────────────────────────────────────
// Test KB/rules without WhatsApp
app.post('/debug/reply', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const userId = await resolveUserId();
  if (!userId) return res.status(500).json({ error: 'No userId found in businesses table' });

  const result = await getReply(userId, text);
  res.json({ userId, input: text, ...result });
});

// ─── BROADCAST ENDPOINT ───────────────────────────────────────────────────────
app.post('/broadcast', async (req, res) => {
  const { user_id, message, phones } = req.body;
  if (!user_id || !message || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'user_id, message, and phones[] required' });
  }

  log('BROADCAST', `Starting — ${phones.length} contacts`);
  const results = { sent: 0, failed: 0 };

  for (const phone of phones) {
    try { await sendWhatsAppMessage(phone, message); results.sent++; }
    catch { results.failed++; }
    await new Promise(r => setTimeout(r, 120));
  }

  await supabase.from('broadcasts').insert({
    user_id, message, total_contacts: phones.length,
    sent_count: results.sent, failed_count: results.failed,
    status: 'completed', cost: phones.length * 1.20,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });

  log('BROADCAST', `Done — Sent: ${results.sent} | Failed: ${results.failed}`);
  res.json({ success: true, ...results });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ConviDeskAI', version: '3.2.0' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ConviDeskAI Backend', version: '3.2.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SERVER', `Running on port ${PORT}`));
