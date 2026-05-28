const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'convideskai123';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function log(tag, msg, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data);
}

async function resolveUserId(phoneId) {
  const { data } = await supabase.from('businesses').select('user_id').eq('phone_number_id', phoneId).maybeSingle();
  if (!data) {
    const { data: first } = await supabase.from('businesses').select('user_id').limit(1).maybeSingle();
    return first?.user_id || null;
  }
  return data.user_id;
}

// ─── CORE LOGIC FUNCTIONS ────────────────────────────────────────────────────
async function upsertConversation(userId, customerPhone, customerName, lastMessage, status) {
  const { data: existing } = await supabase.from('conversations').select('id, unread_count').eq('user_id', userId).eq('customer_phone', customerPhone).maybeSingle();
  if (existing) {
    await supabase.from('conversations').update({ last_message: lastMessage, status: status, unread_count: (existing.unread_count || 0) + 1, updated_at: new Date().toISOString() }).eq('id', existing.id);
    return existing.id;
  } else {
    const { data: newConv } = await supabase.from('conversations').insert({ user_id: userId, customer_phone: customerPhone, customer_name: customerName || customerPhone, last_message: lastMessage, status: status, unread_count: 1, updated_at: new Date().toISOString() }).select('id').single();
    return newConv?.id || null;
  }
}

async function saveMessage(userId, conversationId, customerPhone, text, sender) {
  await supabase.from('messages').insert({ user_id: userId, conversation_id: conversationId, customer_phone: customerPhone, body: text, sender: sender, created_at: new Date().toISOString() });
}

function needsHumanTakeover(text) {
  const triggers = ['complaint', 'refund', 'return', 'damaged', 'agent', 'manager', 'help me', 'urgent'];
  return triggers.some(k => text.toLowerCase().includes(k));
}

async function getReply(userId, customerPhone, text) {
  // Yahan aap apna AI response logic call kar sakte hain
  return { reply: 'Shukriya! Humne aapki query note kar li hai.', tag: 'AI Replied', status: 'ai' };
}

async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: message }
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" } });
  } catch (err) { log("WA_SEND_ERR", err.message); }
}

// ─── WEBHOOK ENDPOINTS ───────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta ko turant response do
  
  const entry = req.body.entry?.[0];
  const value = entry?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  
  if (!message) return;

  const customerPhone = message.from;
  const text = message.text?.body || "";
  const customerName = value?.contacts?.[0]?.profile?.name || customerPhone;

  log('INCOMING', `From: ${customerPhone} | Text: ${text}`);

  const userId = await resolveUserId(PHONE_NUMBER_ID);
  if (!userId) return log('ERROR', 'User not found in DB');

  // Human Takeover
  if (needsHumanTakeover(text)) {
    const convId = await upsertConversation(userId, customerPhone, customerName, text, 'human');
    await saveMessage(userId, convId, customerPhone, text, 'customer');
    await sendWhatsAppMessage(customerPhone, '🙏 Aapki request note kar li gayi hai. Agent jald sampark karenge.');
    return;
  }

  // AI Reply Workflow
  const { reply, tag, status } = await getReply(userId, customerPhone, text);
  const convId = await upsertConversation(userId, customerPhone, customerName, text, status);
  
  await saveMessage(userId, convId, customerPhone, text, 'customer');
  await saveMessage(userId, convId, customerPhone, reply, 'bot');
  await sendWhatsAppMessage(customerPhone, reply);
  
  log('DONE', `Replied to ${customerPhone}`);
});

// ─── SERVER START ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  log('SERVER', `ConviDeskAI backend running on port ${PORT}`);
});
