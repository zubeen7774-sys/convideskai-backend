require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'convidesk123';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] SUPABASE_URL or SUPABASE_KEY missing in environment!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── LOGGER ───────────────────────────────────────────────────────────────────

function log(tag, msg, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data || '');
}

// ─── RESOLVE USER ID ──────────────────────────────────────────────────────────

async function resolveUserId(phoneNumberId) {
  if (phoneNumberId) {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('user_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  const { data } = await supabase
    .from('businesses')
    .select('user_id')
    .limit(1)
    .maybeSingle();

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
    await supabase
      .from('conversations')
      .update({
        last_message: lastMessage,
        status,
        tag: tag || null,
        unread_count: (existing.unread_count || 0) + 1,
        updated_at: now,
      })
      .eq('id', existing.id);
    return existing.id;
  }

  const { data: newConv } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      customer_phone: customerPhone,
      customer_name: customerName || customerPhone,
      last_message: lastMessage,
      status,
      tag: tag || null,
      unread_count: 1,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  return newConv?.id || null;
}

// ─── SAVE MESSAGE ─────────────────────────────────────────────────────────────

async function saveMessage(userId, conversationId, customerPhone, text, sender) {
  const { error } = await supabase.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    customer_phone: customerPhone,
    body: text,
    sender, // 'customer' | 'bot' | 'agent'
    created_at: new Date().toISOString(),
  });
  if (error) log('MSG_SAVE', 'Error', error.message);
}

// ─── LEAD SCORING ─────────────────────────────────────────────────────────────

function calculateLeadScore(text) {
  const t = text.toLowerCase();
  let score = 0;
  ['bulk', 'wholesale', 'order', 'buy', 'purchase', 'distributor', 'dealer', 'franchise', 'contract', 'supply'].forEach(k => { if (t.includes(k)) score += 25; });
  ['price', 'rate', 'cost', 'kitna', 'how much', 'minimum', 'quantity', 'delivery'].forEach(k => { if (t.includes(k)) score += 15; });
  ['interested', 'info', 'details', 'catalogue', 'catalog', 'list'].forEach(k => { if (t.includes(k)) score += 8; });
  return Math.min(score, 99);
}

function detectLeadType(text) {
  const t = text.toLowerCase();
  if (t.includes('bulk') || t.includes('wholesale')) return 'Bulk Order Inquiry';
  if (t.includes('distributor') || t.includes('dealer')) return 'Distributorship Interest';
  if (t.includes('price') || t.includes('rate') || t.includes('kitna')) return 'Pricing Inquiry';
  if (t.includes('delivery') || t.includes('dispatch')) return 'Delivery Inquiry';
  if (t.includes('order')) return 'Order Inquiry';
  if (t.includes('stock') || t.includes('available')) return 'Stock Inquiry';
  return 'General Inquiry';
}

// ─── CAPTURE LEAD ─────────────────────────────────────────────────────────────

async function captureLead(userId, customerPhone, customerName, inquiryType, score) {
  const { data: existing } = await supabase
    .from('leads')
    .select('id, lead_score')
    .eq('user_id', userId)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  if (existing) {
    if (score > (existing.lead_score || 0)) {
      await supabase.from('leads').update({
        lead_score: score,
        inquiry_type: inquiryType,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    }
  } else {
    await supabase.from('leads').insert({
      user_id: userId,
      customer_phone: customerPhone,
      customer_name: customerName || customerPhone,
      inquiry_type: inquiryType,
      lead_score: score,
      created_at: new Date().toISOString(),
    });
    log('LEAD', `Captured: ${customerPhone} | ${inquiryType} | Score: ${score}`);
  }
}

// ─── HUMAN TAKEOVER CHECK ─────────────────────────────────────────────────────

function needsHumanTakeover(text) {
  const t = text.toLowerCase();
  const triggers = ['complaint', 'refund', 'return', 'damaged', 'wrong item',
    'speak to human', 'agent', 'manager', 'help me', 'urgent',
    'problem', 'issue', 'not working', 'fraud', 'cheated'];
  return triggers.some(k => t.includes(k));
}

// ─── CORE AI REPLY LOGIC ──────────────────────────────────────────────────────

async function getReply(userId, customerPhone, text) {
  const t = text.toLowerCase().trim();

  // ── 1. Knowledge Base (keywords match) ───────────────────────────────────
  const { data: kbItems } = await supabase
    .from('knowledge_base')
    .select('title, content, keywords')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (kbItems && kbItems.length > 0) {
    for (const kb of kbItems) {
      // Build keyword list from keywords column OR title
      const kwList = kb.keywords
        ? kb.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : [kb.title?.toLowerCase()].filter(Boolean);

      const matched = kwList.some(kw => t.includes(kw));
      if (matched && kb.content) {
        log('KB', `Matched: "${kb.title}"`);
        return { reply: kb.content, tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // ── 2. Auto Reply Rules (keyword-based) ──────────────────────────────────
  const { data: rules } = await supabase
    .from('auto_reply_rules')
    .select('keyword, reply')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (rules && rules.length > 0) {
    for (const rule of rules) {
      const kw = rule.keyword?.toLowerCase().trim();
      if (kw && t.includes(kw)) {
        log('RULE', `Matched keyword: "${kw}"`);
        return { reply: rule.reply, tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // ── 3. Price Query ────────────────────────────────────────────────────────
  const isPriceQ = /price|rate|kitna|cost|kya hai|btao|how much|kya rate|product list|catalogue|catalog/.test(t);
  const isStockQ = /stock|available|hai kya|milega|in stock|inventory/.test(t);

  if (isPriceQ || isStockQ) {
    const { data: products } = await supabase
      .from('products')
      .select('name, price, stock, category')
      .eq('user_id', userId);

    if (products && products.length > 0) {
      // Check specific product name match
      const specific = products.find(p => t.includes(p.name.toLowerCase()));

      if (specific) {
        const stockStatus = (specific.stock || 0) > 0
          ? `✅ ${specific.stock} units available`
          : '❌ Out of stock';
        return {
          reply: `*${specific.name}*\n💰 Price: ₹${specific.price?.toLocaleString('en-IN')}\n📦 Stock: ${stockStatus}`,
          tag: 'Lead Captured',
          status: 'ai',
        };
      }

      if (isPriceQ) {
        // Group by category
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
        products.forEach(p => {
          reply += `• *${p.name}*: ${(p.stock || 0) > 0 ? `✅ ${p.stock} units` : '❌ Out of stock'}\n`;
        });
        return { reply: reply.trim(), tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // ── 4. Greetings ──────────────────────────────────────────────────────────
  if (/^(hi|hello|hey|helo|hii|helo|assalam|salam|namaste|namaskar|hy|hye)/.test(t)) {
    return {
      reply: '👋 *Aadab!* Hamare store mein aapka swagat hai!\n\nHum aapki kaise madad kar sakte hain?\n\n• 📦 Price list ke liye: *price*\n• 📋 Stock check ke liye: *stock*\n• 🛒 Order ke liye: *order*\n• 📞 Agent se baat ke liye: *agent*',
      tag: 'AI Replied',
      status: 'ai',
    };
  }

  // ── 5. Order query ────────────────────────────────────────────────────────
  if (/order|book|kharidna|lena|chahiye/.test(t)) {
    return {
      reply: '🛒 Order karne ke liye kripya batayein:\n\n1️⃣ Product ka naam\n2️⃣ Quantity\n3️⃣ Delivery address\n\nHum jald confirm karenge! ✅',
      tag: 'Lead Captured',
      status: 'ai',
    };
  }

  // ── 6. Location query ─────────────────────────────────────────────────────
  if (/address|location|kahan|where|shop|store|office/.test(t)) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('address, city')
      .eq('user_id', userId)
      .maybeSingle();
    if (biz?.address) {
      return {
        reply: `📍 *Hamara Address:*\n${biz.address}${biz.city ? ', ' + biz.city : ''}`,
        tag: 'AI Replied',
        status: 'ai',
      };
    }
  }

  // ── 7. Timing query ───────────────────────────────────────────────────────
  if (/time|timing|open|close|hours|baje|kab/.test(t)) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('business_hours')
      .eq('user_id', userId)
      .maybeSingle();
    if (biz?.business_hours) {
      return {
        reply: `⏰ *Business Hours:*\n${biz.business_hours}`,
        tag: 'AI Replied',
        status: 'ai',
      };
    }
  }

  // ── 8. Fallback ───────────────────────────────────────────────────────────
  return {
    reply: 'Shukriya message karne ke liye! 🙏\nAapki query note kar li gayi hai. Hamare agent jald sampark karenge.\n\nYa in options try karein:\n• *price* — Price list\n• *stock* — Stock check\n• *order* — Order karna',
    tag: 'AI Replied',
    status: 'ai',
  };
}

// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, message, phoneNumberId) {
  const pid = phoneNumberId || PHONE_NUMBER_ID;

  if (!WA_TOKEN) { log('WA_ERR', 'WA_TOKEN missing'); return; }
  if (!pid)      { log('WA_ERR', 'PHONE_NUMBER_ID missing'); return; }

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${pid}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: message, preview_url: false },
      },
      {
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    log('WA_SEND', `✅ Sent to ${to} | msgId: ${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    const meta = err.response?.data?.error;
    log('WA_ERR', `❌ Failed to ${to} | ${meta?.code} | ${meta?.message || err.message}`);
    if (meta?.code === 190)    log('WA_ERR', 'FIX: WA_TOKEN expired — get new token from Meta Console');
    if (meta?.code === 100)    log('WA_ERR', 'FIX: PHONE_NUMBER_ID wrong or not connected');
    if (meta?.code === 131030) log('WA_ERR', 'FIX: 24hr window — customer must message first');
  }
}

// ─── WEBHOOK VERIFY ───────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('WEBHOOK', 'Verified ✅');
    return res.status(200).send(challenge);
  }
  log('WEBHOOK', 'Verification failed ❌');
  res.sendStatus(403);
});

// ─── WEBHOOK RECEIVE ──────────────────────────────────────────────────────────

// Dedup cache
const processedMsgs = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta ko turant 200

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value   = body.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;
    if (value.statuses) return; // delivery receipts ignore

    const message = value.messages?.[0];
    if (!message) return;

    // Dedup
    if (processedMsgs.has(message.id)) {
      log('DEDUP', `Skipped duplicate: ${message.id}`);
      return;
    }
    processedMsgs.add(message.id);
    setTimeout(() => processedMsgs.delete(message.id), 10 * 60 * 1000);

    const customerPhone = message.from;
    const customerName  = value.contacts?.[0]?.profile?.name || customerPhone;
    const phoneNumberId = value.metadata?.phone_number_id;
    const msgType       = message.type;

    log('IN', `${customerPhone} | ${customerName} | ${msgType}`);

    // Non-text: politely reject
    if (msgType !== 'text') {
      await sendWhatsAppMessage(customerPhone, 'Filhaal hum sirf text messages handle kar sakte hain. Apna sawaal text mein bhejein. 🙏', phoneNumberId);
      return;
    }

    const text = message.text?.body?.trim();
    if (!text) return;

    // Resolve user
    const userId = await resolveUserId(phoneNumberId);
    if (!userId) {
      log('WARN', 'No userId found — check businesses/whatsapp_accounts table');
      return;
    }

    // Human takeover
    if (needsHumanTakeover(text)) {
      log('TAKEOVER', `Escalating: ${customerPhone}`);
      const convId = await upsertConversation(userId, customerPhone, customerName, text, 'human', 'Human Takeover');
      await saveMessage(userId, convId, customerPhone, text, 'customer');
      await sendWhatsAppMessage(
        customerPhone,
        '🙏 Aapki request humne note kar li hai. Hamare agent jald aapse sampark karenge.\n\nThodi der sabr rakhein — ConviDesk Team',
        phoneNumberId
      );
      return;
    }

    // Lead scoring
    const leadScore = calculateLeadScore(text);
    const leadType  = detectLeadType(text);
    if (leadScore >= 25) {
      await captureLead(userId, customerPhone, customerName, leadType, leadScore);
    }

    // Get AI reply
    const { reply, tag, status } = await getReply(userId, customerPhone, text);

    // Save conversation + messages
    const convId = await upsertConversation(userId, customerPhone, customerName, text, status, tag);
    await saveMessage(userId, convId, customerPhone, text, 'customer');
    await saveMessage(userId, convId, customerPhone, reply, 'bot');

    // Send reply
    await sendWhatsAppMessage(customerPhone, reply, phoneNumberId);

    log('DONE', `Replied to ${customerPhone} | tag: ${tag} | score: ${leadScore}`);

  } catch (err) {
    log('ERROR', 'Webhook error', err.message);
  }
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
    try {
      await sendWhatsAppMessage(phone, message);
      results.sent++;
    } catch {
      results.failed++;
    }
    await new Promise(r => setTimeout(r, 120)); // Rate limit
  }

  await supabase.from('broadcasts').insert({
    user_id,
    message,
    total_contacts: phones.length,
    sent_count: results.sent,
    failed_count: results.failed,
    status: 'completed',
    cost: phones.length * 1.20,
    created_at: new Date().toISOString(),
  });

  log('BROADCAST', `Done — Sent: ${results.sent} | Failed: ${results.failed}`);
  res.json({ success: true, ...results });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ConviDeskAI', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ConviDeskAI Backend', version: '3.0.0' });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('SERVER', `ConviDeskAI backend running on port ${PORT}`);
});
