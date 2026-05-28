const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN   || 'convidesk123';
const WA_TOKEN       = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function log(tag, msg, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data);
}

// Phone number ko user_id mein resolve karta hai (businesses table se)
async function resolveUserId(phone) {
  const { data, error } = await supabase
    .from('businesses')
    .select('user_id')
    .eq('whatsapp_number', phone)
    .maybeSingle();

  if (error) log('RESOLVE', 'businesses lookup error', error.message);

  // Agar specific business nahi mila to pehla business lo
  if (!data) {
    const { data: first } = await supabase
      .from('businesses')
      .select('user_id')
      .limit(1)
      .maybeSingle();
    return first?.user_id || null;
  }
  return data.user_id;
}

// ─── SUPABASE: CONVERSATION UPSERT ───────────────────────────────────────────

async function upsertConversation(userId, customerPhone, customerName, lastMessage, status) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, unread_count')
    .eq('user_id', userId)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('conversations')
      .update({
        last_message: lastMessage,
        status: status,
        unread_count: (existing.unread_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return existing.id;
  } else {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        user_id: userId,
        customer_phone: customerPhone,
        customer_name: customerName || customerPhone,
        last_message: lastMessage,
        status: status,
        unread_count: 1,
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    return newConv?.id || null;
  }
}

// ─── SUPABASE: MESSAGE SAVE ───────────────────────────────────────────────────

async function saveMessage(userId, conversationId, customerPhone, text, sender) {
  const { error } = await supabase
    .from('messages')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      customer_phone: customerPhone,
      body: text,
      sender: sender, // 'customer' | 'bot' | 'agent'
      created_at: new Date().toISOString(),
    });

  if (error) log('MSG_SAVE', 'Error saving message', error.message);
}

// ─── SUPABASE: LEAD CAPTURE ───────────────────────────────────────────────────

async function captureLead(userId, customerPhone, customerName, inquiryType, score, estimatedValue) {
  // Already exists to check karo
  const { data: existing } = await supabase
    .from('leads')
    .select('id, lead_score')
    .eq('user_id', userId)
    .eq('customer_phone', customerPhone)
    .maybeSingle();

  if (existing) {
    // Score update karo agar zyada hai
    if (score > (existing.lead_score || 0)) {
      await supabase
        .from('leads')
        .update({ lead_score: score, inquiry_type: inquiryType, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    await supabase
      .from('leads')
      .insert({
        user_id: userId,
        customer_phone: customerPhone,
        customer_name: customerName || customerPhone,
        inquiry_type: inquiryType,
        lead_score: score,
        estimated_value: estimatedValue || null,
        created_at: new Date().toISOString(),
      });
    log('LEAD', `New lead captured: ${customerPhone} | ${inquiryType} | Score: ${score}`);
  }
}

// ─── LEAD SCORING ─────────────────────────────────────────────────────────────

function calculateLeadScore(text) {
  let score = 0;
  const t = text.toLowerCase();

  // High intent keywords
  const highIntent = ['bulk', 'wholesale', 'order', 'buy', 'purchase', 'distributor',
    'dealer', 'franchise', 'contract', 'supply', 'import', 'export'];
  const medIntent  = ['price', 'rate', 'cost', 'kitna', 'how much', 'kya rate',
    'minimum', 'quantity', 'delivery', 'dispatch'];
  const lowIntent  = ['interested', 'info', 'details', 'catalogue', 'catalog', 'list'];

  highIntent.forEach(k => { if (t.includes(k)) score += 25; });
  medIntent.forEach(k  => { if (t.includes(k)) score += 15; });
  lowIntent.forEach(k  => { if (t.includes(k)) score += 8; });

  return Math.min(score, 99);
}

function detectLeadType(text) {
  const t = text.toLowerCase();
  if (t.includes('bulk') || t.includes('wholesale')) return 'Bulk Order Inquiry';
  if (t.includes('distributor') || t.includes('dealer'))  return 'Distributorship Interest';
  if (t.includes('price') || t.includes('rate') || t.includes('kitna')) return 'Pricing Inquiry';
  if (t.includes('delivery') || t.includes('dispatch'))   return 'Delivery Inquiry';
  if (t.includes('order'))  return 'Order Inquiry';
  if (t.includes('stock') || t.includes('available'))     return 'Stock Inquiry';
  return 'General Inquiry';
}

// ─── HUMAN TAKEOVER CHECK ─────────────────────────────────────────────────────

function needsHumanTakeover(text) {
  const triggers = [
    'complaint', 'refund', 'return', 'damaged', 'wrong item',
    'speak to human', 'agent', 'manager', 'help me', 'urgent',
    'problem', 'issue', 'not working', 'fraud', 'cheated'
  ];
  const t = text.toLowerCase();
  return triggers.some(k => t.includes(k));
}

// ─── CORE REPLY LOGIC ─────────────────────────────────────────────────────────

async function getReply(userId, customerPhone, text) {
  const t = text.toLowerCase().trim();

  // 1. Knowledge Base check (FAQ)
  const { data: kbItems } = await supabase
    .from('knowledge_base')
    .select('title, content, keywords')
    .eq('user_id', userId);

  if (kbItems && kbItems.length > 0) {
    for (const kb of kbItems) {
      const keywords = kb.keywords
        ? kb.keywords.split(',').map(k => k.trim().toLowerCase())
        : [kb.title.toLowerCase()];

      const matched = keywords.some(k => t.includes(k));
      if (matched && kb.content) {
        log('KB', `Matched KB item: ${kb.title}`);
        return { reply: kb.content, tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // 2. Price query
  if (t.includes('price') || t.includes('rate') || t.includes('kitna') ||
      t.includes('cost') || t.includes('kya hai') || t.includes('btao') ||
      t.includes('how much') || t.includes('kya rate')) {

    const { data: products } = await supabase
      .from('products')
      .select('name, price, stock')
      .eq('user_id', userId);

    if (products && products.length > 0) {
      let reply = '📦 *Hamare Products ki Price List:*\n\n';
      products.forEach(p => {
        reply += `• *${p.name}* — ₹${p.price?.toLocaleString('en-IN')}\n`;
      });
      reply += '\n📞 Bulk order ya special rate ke liye directly contact karein!';
      return { reply, tag: 'Lead Captured', status: 'ai' };
    }
  }

  // 3. Stock query
  if (t.includes('stock') || t.includes('available') ||
      t.includes('hai kya') || t.includes('milega') || t.includes('in stock')) {

    const { data: products } = await supabase
      .from('products')
      .select('name, stock')
      .eq('user_id', userId);

    if (products && products.length > 0) {
      let reply = '✅ *Stock Availability:*\n\n';
      products.forEach(p => {
        const status = (p.stock > 0)
          ? `✅ ${p.stock} units available`
          : '❌ Out of stock';
        reply += `• *${p.name}*: ${status}\n`;
      });
      return { reply, tag: 'AI Replied', status: 'ai' };
    }
  }

  // 4. Auto reply rules (keyword-based)
  const { data: rules } = await supabase
    .from('auto_reply_rules')
    .select('keyword, reply, is_active')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (rules && rules.length > 0) {
    for (const rule of rules) {
      const keyword = rule.keyword?.toLowerCase();
      if (keyword && t.includes(keyword)) {
        log('RULE', `Matched rule keyword: ${keyword}`);
        return { reply: rule.reply, tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // 5. Greeting
  if (t === 'hi' || t === 'hello' || t === 'hlo' || t === 'hey' ||
      t === 'hii' || t === 'assalam' || t.includes('namaste') || t.includes('namaskar')) {
    return {
      reply: '👋 *Aadab!* ConviDesk mein aapka swagat hai!\n\nHum aapki kaise madad kar sakte hain?\n\n• 📦 *Product price* jaanne ke liye "price" likhen\n• 📋 *Stock* check karne ke liye "stock" likhen\n• 📞 *Agent se baat* karne ke liye "agent" likhen',
      tag: 'AI Replied',
      status: 'ai'
    };
  }

  // 6. Default fallback
  return {
    reply: 'Shukriya message karne ke liye! 🙏\nAapki query note kar li gayi hai. Hamare agent jald aapse sampark karenge.\n\n_ConviDesk AI_',
    tag: 'AI Replied',
    status: 'ai'
  };
}

// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message, preview_url: false }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    log('WA_SEND', `Sent to ${to}`);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    log('WA_SEND_ERR', `Failed to send to ${to}`, errMsg);
  }
}

// ─── WEBHOOK VERIFY ───────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('WEBHOOK', 'Verified successfully');
    res.status(200).send(challenge);
  } else {
    log('WEBHOOK', 'Verification failed');
    res.sendStatus(403);
  }
});

// ─── WEBHOOK RECEIVE ─────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  // Meta ko turant 200 do — warna retry karega
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // ── Status update (delivered/read) — ignore ──
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    const customerPhone = message.from;
    const msgType       = message.type;

    // Customer ka naam (contacts array se)
    const customerName = value?.contacts?.[0]?.profile?.name || customerPhone;

    log('INCOMING', `From: ${customerPhone} | Name: ${customerName} | Type: ${msgType}`);

    // Sirf text messages handle karo abhi
    if (msgType !== 'text') {
      await sendWhatsAppMessage(
        customerPhone,
        'Filhaal hum sirf text messages handle kar sakte hain. Please apna sawaal text mein bhejein. 🙏'
      );
      return;
    }

    const text = message.text?.body || '';
    if (!text.trim()) return;

    // ── User resolve karo ──
    const userId = await resolveUserId(PHONE_NUMBER_ID);
    if (!userId) {
      log('WARN', 'No userId found — check businesses table');
      return;
    }

    // ── Human takeover check ──
    if (needsHumanTakeover(text)) {
      log('TAKEOVER', `Human escalation triggered for ${customerPhone}`);

      const convId = await upsertConversation(
        userId, customerPhone, customerName, text, 'human'
      );
      await saveMessage(userId, convId, customerPhone, text, 'customer');

      await sendWhatsAppMessage(
        customerPhone,
        '🙏 Aapki request humne note kar li hai. Hamare agent jald aapse sampark karenge.\n\nThodi der sabr rakhein — ConviDesk Team'
      );

      // Conversation status human mein update
      await supabase
        .from('conversations')
        .update({ status: 'human', tag: 'Human Takeover' })
        .eq('user_id', userId)
        .eq('customer_phone', customerPhone);

      return;
    }

    // ── Lead scoring ──
    const leadScore = calculateLeadScore(text);
    const leadType  = detectLeadType(text);

    if (leadScore >= 25) {
      await captureLead(userId, customerPhone, customerName, leadType, leadScore, null);
    }

    // ── AI Reply generate karo ──
    const { reply, tag, status } = await getReply(userId, customerPhone, text);

    // ── Conversation upsert ──
    const convId = await upsertConversation(
      userId, customerPhone, customerName, text, status
    );

    // Tag update karo
    if (convId) {
      await supabase
        .from('conversations')
        .update({ tag: tag })
        .eq('id', convId);
    }

    // ── Messages save karo ──
    await saveMessage(userId, convId, customerPhone, text, 'customer');
    await saveMessage(userId, convId, customerPhone, reply, 'bot');

    // ── WhatsApp pe reply bhejo ──
    await sendWhatsAppMessage(customerPhone, reply);

    log('DONE', `Replied to ${customerPhone} | Tag: ${tag} | Lead Score: ${leadScore}`);

  } catch (err) {
    log('ERROR', 'Webhook processing error', err.message);
  }
});

// ─── BROADCAST ENDPOINT ───────────────────────────────────────────────────────
// POST /broadcast
// Body: { user_id, message, phones: ["919876543210", ...] }

app.post('/broadcast', async (req, res) => {
  const { user_id, message, phones } = req.body;

  if (!user_id || !message || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'user_id, message, and phones[] required' });
  }

  log('BROADCAST', `Sending to ${phones.length} contacts`);

  const results = { sent: 0, failed: 0 };

  for (const phone of phones) {
    try {
      await sendWhatsAppMessage(phone, message);
      results.sent++;
      // Rate limit — 1 message per 100ms
      await new Promise(r => setTimeout(r, 100));
    } catch {
      results.failed++;
    }
  }

  // Broadcast record save karo
  await supabase.from('broadcasts').insert({
    user_id,
    message,
    total_sent: results.sent,
    total_failed: results.failed,
    created_at: new Date().toISOString(),
  });

  log('BROADCAST', `Done — Sent: ${results.sent} | Failed: ${results.failed}`);
  res.json({ success: true, ...results });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'ConviDeskAI Backend'
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('SERVER', `ConviDeskAI backend running on port ${PORT}`);
});
