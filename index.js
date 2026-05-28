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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function log(tag, msg, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, data);
}

// FIXED: Database lookup ke liye function
async function resolveUserId(phoneId) {
  // Yahan agar aapka database mein business number store hai, 
  // toh ensure karein ki query sahi column par ho.
  const { data, error } = await supabase
    .from('businesses')
    .select('user_id')
    .eq('phone_number_id', phoneId) // Yahan column check karein
    .maybeSingle();

  if (error) log('RESOLVE', 'businesses lookup error', error.message);
  
  if (!data) {
    const { data: first } = await supabase.from('businesses').select('user_id').limit(1).maybeSingle();
    return first?.user_id || null;
  }
  return data.user_id;
}

// ─── SUPABASE FUNCTIONS (Upsert/Save/Lead) ──
// (Aapka baki function logic yahan same rahega)
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

async function captureLead(userId, customerPhone, customerName, inquiryType, score, estimatedValue) {
  const { data: existing } = await supabase.from('leads').select('id, lead_score').eq('user_id', userId).eq('customer_phone', customerPhone).maybeSingle();
  if (existing) {
    if (score > (existing.lead_score || 0)) await supabase.from('leads').update({ lead_score: score, inquiry_type: inquiryType, updated_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('leads').insert({ user_id: userId, customer_phone: customerPhone, customer_name: customerName || customerPhone, inquiry_type: inquiryType, lead_score: score, estimated_value: estimatedValue || null, created_at: new Date().toISOString() });
  }
}

function calculateLeadScore(text) {
  let score = 0;
  const t = text.toLowerCase();
  ['bulk', 'wholesale', 'order', 'buy', 'purchase', 'distributor', 'dealer', 'franchise', 'contract', 'supply', 'import', 'export'].forEach(k => { if (t.includes(k)) score += 25; });
  return Math.min(score, 99);
}

function detectLeadType(text) {
  const t = text.toLowerCase();
  if (t.includes('bulk') || t.includes('wholesale')) return 'Bulk Order Inquiry';
  return 'General Inquiry';
}

function needsHumanTakeover(text) {
  const triggers = ['complaint', 'refund', 'return', 'damaged', 'agent', 'manager', 'help me', 'urgent'];
  return triggers.some(k => text.toLowerCase().includes(k));
}

async function getReply(userId, customerPhone, text) {
  return { reply: 'Shukriya! Humne aapki query note kar li hai.', tag: 'AI Replied', status: 'ai' };
}

async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: message }
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  } catch (err) { log("WA_SEND_ERR", err.message); }
}

// ─── WEBHOOKS ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const userId = await resolveUserId(PHONE_NUMBER_ID);
  if (!userId) return log('ERROR', 'User not found');
  
  // (Baaki logic yahan call karein...)
});

// ─── START SERVER (FIXED) ──────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  log('SERVER', `ConviDeskAI backend running on port ${PORT}`);
});
