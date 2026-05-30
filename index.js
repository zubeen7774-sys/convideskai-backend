require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'convidesk123';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] SUPABASE_URL or SUPABASE_KEY missing in .env!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── LOGGER ───────────────────────────────────────────────────
function log(tag, msg, data = '') {
  const d = data ? (typeof data === 'object' ? JSON.stringify(data) : data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg} ${d}`);
}

// ═════════════════════════════════════════════════════════════
// DB HELPERS
// ═════════════════════════════════════════════════════════════

// businesses table se user_id lo
async function resolveUserId() {
  const { data, error } = await supabase
    .from('businesses')
    .select('user_id')
    .limit(1)
    .maybeSingle();
  if (error) log('RESOLVE_ERR', error.message);
  const uid = data?.user_id || null;
  log('RESOLVE', uid ? `userId = ${uid}` : '❌ businesses table empty — add a row!');
  return uid;
}

// Conversation create ya update karo
async function upsertConversation(userId, phone, name, lastMsg, status, tag) {
  const { data: ex } = await supabase
    .from('conversations')
    .select('id, unread_count')
    .eq('user_id', userId)
    .eq('customer_phone', phone)
    .maybeSingle();

  const now = new Date().toISOString();

  if (ex) {
    await supabase.from('conversations').update({
      last_message: lastMsg,
      status,
      tag: tag || null,
      unread_count: (ex.unread_count || 0) + 1,
      updated_at: now,
    }).eq('id', ex.id);
    return ex.id;
  }

  const { data: nc } = await supabase.from('conversations').insert({
    user_id: userId,
    customer_phone: phone,
    customer_name: name || phone,
    last_message: lastMsg,
    status,
    tag: tag || null,
    unread_count: 1,
    created_at: now,
    updated_at: now,
  }).select('id').single();

  return nc?.id || null;
}

// Message save karo
async function saveMessage(userId, convId, phone, body, sender) {
  const { error } = await supabase.from('messages').insert({
    user_id: userId,
    conversation_id: convId,
    customer_phone: phone,
    body,
    sender,
    created_at: new Date().toISOString(),
  });
  if (error) log('MSG_ERR', error.message);
}

// ═════════════════════════════════════════════════════════════
// LEAD SCORING
// ═════════════════════════════════════════════════════════════

function calcLeadScore(text) {
  const t = text.toLowerCase();
  let score = 0;
  ['bulk','wholesale','order','buy','purchase','distributor','dealer']
    .forEach(k => { if (t.includes(k)) score += 25; });
  ['price','rate','cost','kitna','how much','minimum','quantity','delivery']
    .forEach(k => { if (t.includes(k)) score += 15; });
  ['interested','info','details','catalogue','catalog','list']
    .forEach(k => { if (t.includes(k)) score += 8; });
  return Math.min(score, 99);
}

function detectLeadType(text) {
  const t = text.toLowerCase();
  if (t.includes('bulk') || t.includes('wholesale'))       return 'Bulk Order Inquiry';
  if (t.includes('distributor') || t.includes('dealer'))   return 'Distributorship Interest';
  if (t.includes('price') || t.includes('rate') || t.includes('kitna')) return 'Pricing Inquiry';
  if (t.includes('delivery'))   return 'Delivery Inquiry';
  if (t.includes('order'))      return 'Order Inquiry';
  if (t.includes('stock') || t.includes('available'))      return 'Stock Inquiry';
  return 'General Inquiry';
}

async function captureLead(userId, phone, name, inquiryType, score) {
  const { data: ex } = await supabase.from('leads')
    .select('id, lead_score')
    .eq('user_id', userId)
    .eq('customer_phone', phone)
    .maybeSingle();

  if (ex) {
    if (score > (ex.lead_score || 0)) {
      await supabase.from('leads').update({
        lead_score: score,
        inquiry_type: inquiryType,
        updated_at: new Date().toISOString(),
      }).eq('id', ex.id);
    }
  } else {
    await supabase.from('leads').insert({
      user_id: userId,
      customer_phone: phone,
      customer_name: name || phone,
      inquiry_type: inquiryType,
      lead_score: score,
      created_at: new Date().toISOString(),
    });
    log('LEAD', `Captured ${phone} | ${inquiryType} | score ${score}`);
  }
}

// ═════════════════════════════════════════════════════════════
// HUMAN TAKEOVER CHECK
// ═════════════════════════════════════════════════════════════

function needsHuman(text) {
  const t = text.toLowerCase();
  return [
    'speak to human','speak to agent','human agent',
    'manager chahiye','agent chahiye','complaint karna hai',
    'fraud hua','cheated','wrong item mila','damaged item',
    'refund chahiye','paisa wapas',
  ].some(k => t.includes(k));
}

// ═════════════════════════════════════════════════════════════
// SEND WHATSAPP MESSAGE
// ═════════════════════════════════════════════════════════════

async function sendWA(to, message, phoneNumberId) {
  const pid   = phoneNumberId || PHONE_NUMBER_ID;
  const token = WA_TOKEN;

  log('WA_TRY', `to=${to} pid=${pid} token=${token ? token.slice(0,15)+'...' : 'MISSING'}`);

  if (!token) { log('WA_ERR', '❌ WA_TOKEN missing'); return false; }
  if (!pid)   { log('WA_ERR', '❌ PHONE_NUMBER_ID missing'); return false; }

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
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );
    log('WA_OK', `✅ Sent to ${to} | id: ${res.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    const e = err.response?.data?.error;
    log('WA_ERR', `❌ to=${to} code=${e?.code} msg=${e?.message || err.message}`);
    if (e?.code === 190)    log('WA_FIX', '→ Token expired — get new token from Meta Console');
    if (e?.code === 100)    log('WA_FIX', '→ Wrong PHONE_NUMBER_ID — check Meta Console');
    if (e?.code === 131030) log('WA_FIX', '→ Customer is outside 24hr window — use template');
    if (e?.code === 131047) log('WA_FIX', '→ Use approved message template');
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
// CORE AI REPLY ENGINE
// ═════════════════════════════════════════════════════════════

async function getReply(userId, text) {
  const t = text.toLowerCase().trim();
  log('REPLY', `"${text.slice(0, 80)}" | userId=${userId}`);

  // ── 1. Knowledge Base ────────────────────────────────────────
  const { data: kbRows, error: kbErr } = await supabase
    .from('knowledge_base')
    .select('title, content, keywords, is_active')
    .eq('user_id', userId);

  if (kbErr) log('KB_ERR', kbErr.message);
  log('KB', `${kbRows?.length || 0} entries fetched`);

  if (kbRows?.length > 0) {
    const activeKB = kbRows.filter(r => r.is_active !== false);
    log('KB', `${activeKB.length} active`);

    for (const kb of activeKB) {
      const kwList = kb.keywords
        ? kb.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : [kb.title?.toLowerCase()].filter(Boolean);

      const matched = kwList.some(kw => kw && t.includes(kw));
      if (matched && kb.content) {
        log('KB_MATCH', `✅ "${kb.title}"`);
        return { reply: kb.content, tag: 'AI Replied', status: 'ai' };
      }
    }
    log('KB', 'No match');
  }

  // ── 2. Auto Reply Rules ──────────────────────────────────────
  const { data: rules, error: rulesErr } = await supabase
    .from('auto_reply_rules')
    .select('keyword, reply, is_active')
    .eq('user_id', userId);

  if (rulesErr) log('RULES_ERR', rulesErr.message);
  log('RULES', `${rules?.length || 0} rules fetched`);

  if (rules?.length > 0) {
    const active = rules.filter(r => r.is_active !== false);
    for (const rule of active) {
      const kw = rule.keyword?.toLowerCase().trim();
      if (kw && t.includes(kw)) {
        log('RULES_MATCH', `✅ keyword="${kw}"`);
        return { reply: rule.reply, tag: 'AI Replied', status: 'ai' };
      }
    }
    log('RULES', 'No match');
  }

  // ── 3. Product Price / Stock ─────────────────────────────────
  const isPriceQ = /price|rate|kitna|cost|kya hai|btao|how much|product list|catalogue|catalog|list/.test(t);
  const isStockQ = /stock|available|hai kya|milega|in stock|stok/.test(t);

  if (isPriceQ || isStockQ) {
    const { data: prods } = await supabase
      .from('products')
      .select('name, price, stock, category')
      .eq('user_id', userId);

    log('PRODS', `${prods?.length || 0} products`);

    if (prods?.length > 0) {
      // Specific product mentioned?
      const specific = prods.find(p => t.includes(p.name?.toLowerCase()));
      if (specific) {
        const stockTxt = (specific.stock || 0) > 0
          ? `✅ ${specific.stock} units available`
          : '❌ Out of stock';
        return {
          reply: `*${specific.name}*\n💰 Price: ₹${(specific.price || 0).toLocaleString('en-IN')}\n📦 Stock: ${stockTxt}`,
          tag: 'Lead Captured',
          status: 'ai',
        };
      }

      if (isPriceQ) {
        const byCat = prods.reduce((acc, p) => {
          const cat = p.category || 'Products';
          if (!acc[cat]) acc[cat] = [];
          acc[cat].push(p);
          return acc;
        }, {});

        let reply = '📋 *Hamare Products:*\n\n';
        for (const [cat, items] of Object.entries(byCat)) {
          if (Object.keys(byCat).length > 1) reply += `*${cat}*\n`;
          items.forEach(p => {
            reply += `• ${p.name}: ₹${(p.price || 0).toLocaleString('en-IN')}\n`;
          });
          reply += '\n';
        }
        reply += '📞 Bulk order ke liye directly contact karein!';
        return { reply: reply.trim(), tag: 'Lead Captured', status: 'ai' };
      }

      if (isStockQ) {
        let reply = '📦 *Stock Status:*\n\n';
        prods.forEach(p => {
          const s = (p.stock || 0) > 0 ? `✅ ${p.stock} units` : '❌ Out of stock';
          reply += `• *${p.name}*: ${s}\n`;
        });
        return { reply: reply.trim(), tag: 'AI Replied', status: 'ai' };
      }
    }
  }

  // ── 4. Greetings ─────────────────────────────────────────────
  if (/^(hi|hello|hey|helo|hii|assalam|salam|namaste|namaskar|hy|hye|aadab|adaab)\b/.test(t)) {
    return {
      reply: '👋 *Aadab!* Hamare store mein aapka swagat hai! 🙏\n\nHum aapki kaise madad kar sakte hain?\n\n• 📋 Price list → *price*\n• 📦 Stock check → *stock*\n• 🛒 Order karna → *order*\n• 📞 Agent se baat → *agent chahiye*',
      tag: 'AI Replied',
      status: 'ai',
    };
  }

  // ── 5. Order ─────────────────────────────────────────────────
  if (/\border\b|book karna|kharidna|lena hai|chahiye|purchase/.test(t)) {
    return {
      reply: '🛒 *Order karne ke liye batayein:*\n\n1️⃣ Product ka naam\n2️⃣ Quantity kitni chahiye\n3️⃣ Delivery address\n\nHum jald hi confirm karenge! ✅',
      tag: 'Lead Captured',
      status: 'ai',
    };
  }

  // ── 6. Location / Address ────────────────────────────────────
  if (/address|location|kahan|where are you|shop|store|office|dukaan/.test(t)) {
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

  // ── 7. Timings ───────────────────────────────────────────────
  if (/timing|time|open|close|hours|baje|kab khulta|kab band/.test(t)) {
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

  // ── 8. Return / Refund ───────────────────────────────────────
  if (/return|refund|wapas|cancel|exchange|replace/.test(t)) {
    return {
      reply: '🔄 *Return / Refund Policy:*\n\n• 7 din ke andar return kar sakte hain\n• Product original condition mein hona chahiye\n• Refund 3–5 business days mein milega\n\nMore info ke liye agent se baat karein: *agent chahiye*',
      tag: 'AI Replied',
      status: 'ai',
    };
  }

  // ── 9. Delivery ──────────────────────────────────────────────
  if (/delivery|shipping|dispatch|bhejo|courier|kitne din/.test(t)) {
    return {
      reply: '🚚 *Delivery Info:*\n\n• Order confirm hone ke 24–48 ghante mein dispatch\n• Delivery 3–7 business days\n• Tracking link message pe bheja jaayega\n\nKoi aur sawaal? *agent chahiye* likhein',
      tag: 'AI Replied',
      status: 'ai',
    };
  }

  // ── 10. Fallback ─────────────────────────────────────────────
  log('REPLY', 'Using fallback');
  return {
    reply: 'Shukriya message karne ke liye! 🙏\n\nAapki query note kar li gayi hai. Hamare agent jald sampark karenge.\n\n*Jaldi reply ke liye try karein:*\n• *price* — Price list\n• *stock* — Stock info\n• *order* — Order karna\n• *agent chahiye* — Agent se baat',
    tag: 'AI Replied',
    status: 'ai',
  };
}

// ═════════════════════════════════════════════════════════════
// WEBHOOK — VERIFY
// ═════════════════════════════════════════════════════════════

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('WEBHOOK', '✅ Verified');
    return res.status(200).send(challenge);
  }
  log('WEBHOOK', '❌ Verification failed');
  res.sendStatus(403);
});

// ═════════════════════════════════════════════════════════════
// WEBHOOK — RECEIVE MESSAGES
// ═════════════════════════════════════════════════════════════

const processedMsgs = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta ko turant 200 dena zaroori hai

  try {
    const body  = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value)          return;
    if (value.statuses)  return; // Delivery receipts ignore karo

    const message = value.messages?.[0];
    if (!message) return;

    // Duplicate prevention
    if (processedMsgs.has(message.id)) {
      log('DEDUP', `Skipped: ${message.id}`);
      return;
    }
    processedMsgs.add(message.id);
    setTimeout(() => processedMsgs.delete(message.id), 10 * 60 * 1000);

    const customerPhone = message.from;
    const customerName  = value.contacts?.[0]?.profile?.name || customerPhone;
    const phoneNumberId = value.metadata?.phone_number_id;
    const msgType       = message.type;

    log('IN', `From=${customerPhone} Name="${customerName}" Type=${msgType}`);

    // Non-text messages handle karo
    if (msgType !== 'text') {
      if (msgType === 'image')    await sendWA(customerPhone, '🖼 Image mila! Text mein apna sawaal likhein please.', phoneNumberId);
      else if (msgType === 'audio') await sendWA(customerPhone, '🎤 Voice note mila! Text mein likhein please.', phoneNumberId);
      else                        await sendWA(customerPhone, '📎 File mili! Abhi hum sirf text handle karte hain. 🙏', phoneNumberId);
      return;
    }

    const text = message.text?.body?.trim();
    if (!text) return;
    log('IN_TEXT', `"${text}"`);

    const userId = await resolveUserId();
    if (!userId) {
      log('WARN', '❌ No userId — businesses table mein ek row add karo!');
      return;
    }

    // Human takeover check
    if (needsHuman(text)) {
      log('TAKEOVER', customerPhone);
      const convId = await upsertConversation(userId, customerPhone, customerName, text, 'human', 'Human Takeover');
      await saveMessage(userId, convId, customerPhone, text, 'customer');
      await sendWA(customerPhone, '🙏 Samajh gaye. Hamare agent jald aapse sampark karenge.\n\nThoda intezaar karein — ConviDesk Team', phoneNumberId);
      return;
    }

    // Lead scoring
    const score    = calcLeadScore(text);
    const leadType = detectLeadType(text);
    if (score >= 25) await captureLead(userId, customerPhone, customerName, leadType, score);

    // AI reply generate karo
    const { reply, tag, status } = await getReply(userId, text);
    log('REPLY_READY', `tag=${tag} reply="${reply.slice(0, 70)}…"`);

    // DB mein save karo
    const convId = await upsertConversation(userId, customerPhone, customerName, text, status, tag);
    await saveMessage(userId, convId, customerPhone, text, 'customer');
    await saveMessage(userId, convId, customerPhone, reply, 'bot');

    // WhatsApp pe bhejo
    await sendWA(customerPhone, reply, phoneNumberId);
    log('DONE', `✅ Replied to ${customerPhone} | tag=${tag} | leadScore=${score}`);

  } catch (err) {
    log('ERROR', `Webhook crash: ${err.message}`);
    console.error(err.stack);
  }
});

// ═════════════════════════════════════════════════════════════
// BROADCAST — SEND TO MULTIPLE CONTACTS
// ═════════════════════════════════════════════════════════════

app.post('/broadcast', async (req, res) => {
  const { broadcast_id, user_id, message, phones } = req.body;

  if (!user_id || !message || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'user_id, message, phones[] required' });
  }

  log('BROADCAST', `Starting | contacts=${phones.length} | broadcast_id=${broadcast_id || 'none'}`);

  // Status: queued → running
  if (broadcast_id) {
    await supabase.from('broadcasts')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', broadcast_id);
  }

  const results   = { sent: 0, failed: 0, skipped: 0 };
  const sentSet   = new Set(); // Duplicate phone protection

  for (const rawPhone of phones) {
    const phone = String(rawPhone).trim();
    if (!phone) continue;

    // Duplicate skip
    if (sentSet.has(phone)) {
      results.skipped++;
      log('BROADCAST_SKIP', `Duplicate: ${phone}`);
      continue;
    }
    sentSet.add(phone);

    const ok = await sendWA(phone, message, PHONE_NUMBER_ID);

    if (ok) {
      results.sent++;
      if (broadcast_id) {
        await supabase.from('broadcast_logs').insert({
          user_id,
          broadcast_id,
          phone,
          status: 'sent',
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
      }
    } else {
      results.failed++;
      if (broadcast_id) {
        await supabase.from('broadcast_logs').insert({
          user_id,
          broadcast_id,
          phone,
          status: 'failed',
          error_message: 'WhatsApp send failed',
          created_at: new Date().toISOString(),
        });
      }

      // Failed contact ka ₹1.20 refund wallet mein wapas
      if (user_id) {
        const { data: w } = await supabase
          .from('user_wallet')
          .select('id, balance')
          .eq('user_id', user_id)
          .single();

        if (w) {
          const newBal = (w.balance || 0) + 1.20;
          await supabase.from('user_wallet').update({ balance: newBal }).eq('id', w.id);
          await supabase.from('wallet_transactions').insert({
            user_id,
            wallet_id: w.id,
            broadcast_id: broadcast_id || null,
            amount: 1.20,
            type: 'refund',
            description: `Auto-refund: ${phone} send failed`,
            balance_before: w.balance,
            balance_after: newBal,
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    // Progress update har 10 messages pe
    if (broadcast_id && (results.sent + results.failed) % 10 === 0) {
      await supabase.from('broadcasts').update({
        success_count:      results.sent,
        failed_count:       results.failed,
        skipped_duplicates: results.skipped,
      }).eq('id', broadcast_id);
    }

    // Rate limiting — 120ms delay (WhatsApp limit se safe)
    await new Promise(r => setTimeout(r, 120));
  }

  // Final update
  if (broadcast_id) {
    await supabase.from('broadcasts').update({
      status:             'completed',
      success_count:      results.sent,
      failed_count:       results.failed,
      skipped_duplicates: results.skipped,
      completed_at:       new Date().toISOString(),
    }).eq('id', broadcast_id);
  } else {
    // broadcast_id nahi diya toh naya record insert karo
    await supabase.from('broadcasts').insert({
      user_id,
      name:             `Manual Broadcast ${new Date().toLocaleDateString('en-IN')}`,
      message,
      status:           'completed',
      recipients_count: phones.length,
      success_count:    results.sent,
      failed_count:     results.failed,
      skipped_duplicates: results.skipped,
      cost:             phones.length * 1.20,
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    });
  }

  log('BROADCAST', `✅ Done | sent=${results.sent} failed=${results.failed} skipped=${results.skipped}`);
  res.json({ success: true, ...results });
});

// ═════════════════════════════════════════════════════════════
// DEBUG — KB/RULES TEST (WhatsApp ke bina)
// ═════════════════════════════════════════════════════════════

app.post('/debug/reply', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const userId = await resolveUserId();
  if (!userId) return res.status(500).json({ error: 'No userId in businesses table' });

  const result = await getReply(userId, text);
  res.json({ userId, input: text, ...result });
});

// ═════════════════════════════════════════════════════════════
// DEBUG — Send test message directly
// ═════════════════════════════════════════════════════════════

app.post('/debug/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const ok = await sendWA(phone, message, PHONE_NUMBER_ID);
  res.json({ success: ok, phone, message });
});

// ═════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'ConviDeskAI',
    version:   '4.0.0',
    timestamp: new Date().toISOString(),
    env: {
      supabase:       !!SUPABASE_URL,
      wa_token:       !!WA_TOKEN,
      phone_id:       !!PHONE_NUMBER_ID,
      verify_token:   !!VERIFY_TOKEN,
    },
  });
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ConviDeskAI Backend', version: '4.0.0' }));

// ═════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('SERVER', `🚀 Running on port ${PORT}`);
  log('SERVER', `Supabase: ${SUPABASE_URL ? '✅' : '❌ MISSING'}`);
  log('SERVER', `WA Token: ${WA_TOKEN ? '✅' : '❌ MISSING'}`);
  log('SERVER', `Phone ID: ${PHONE_NUMBER_ID ? '✅' : '❌ MISSING'}`);
});
