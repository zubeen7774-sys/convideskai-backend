const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "convidesk123";
const WA_TOKEN = process.env.WA_TOKEN;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta ko turant 200 do
  
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message || message.type !== 'text') return;

  const from = message.from;
  const text = message.text.body.toLowerCase().trim();
  const phoneNumberId = entry?.metadata?.phone_number_id;
  const messageId = message.id;

  // Duplicate check
  const { data: existing } = await supabase
    .from('processed_messages')
    .select('id')
    .eq('message_id', messageId)
    .maybeSingle();

  if (existing) return;

  await supabase
    .from('processed_messages')
    .insert({ message_id: messageId });

  const reply = await getReply(from, text, phoneNumberId);
  await sendMessage(from, reply, phoneNumberId);
});

async function getReply(from, text, phoneNumberId) {
  try {
    // Step 1: phone_number_id se client dhundo
    let userId = null;

    if (phoneNumberId) {
      const { data: waAccount } = await supabase
        .from('whatsapp_accounts')
        .select('user_id')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();
      userId = waAccount?.user_id;
    }

    // Fallback: pehla business
    if (!userId) {
      const { data: firstBusiness } = await supabase
        .from('businesses')
        .select('user_id')
        .limit(1)
        .maybeSingle();
      userId = firstBusiness?.user_id;
    }

    if (!userId) return "Shukriya! Hum jald reply karenge.";

    // Step 2: Knowledge Base
    const { data: knowledge } = await supabase
      .from('knowledge_base')
      .select('title, content')
      .eq('user_id', userId);

    if (knowledge?.length > 0) {
      for (const item of knowledge) {
        if (item.title && text.includes(item.title.toLowerCase())) {
          return item.content;
        }
      }
    }

    // Step 3: Auto Reply Rules
    const { data: rules } = await supabase
      .from('auto_reply_rules')
      .select('keyword, reply')
      .eq('user_id', userId);

    if (rules?.length > 0) {
      for (const rule of rules) {
        const keyword = rule.keyword?.toLowerCase();
        if (keyword && text.includes(keyword)) {
          return rule.reply;
        }
      }
    }

    // Step 4: Products
    if (/price|rate|kitna|cost|kya hai|btao|product|list/.test(text)) {
      const { data: products } = await supabase
        .from('products')
        .select('name, price, stock')
        .eq('user_id', userId);

      if (products?.length > 0) {
        let reply = "Hamare products ki price list:\n\n";
        products.forEach(p => {
          reply += `• ${p.name}: ₹${p.price}\n`;
        });
        return reply;
      }
    }

    if (/stock|available|hai kya|milega/.test(text)) {
      const { data: products } = await supabase
        .from('products')
        .select('name, stock')
        .eq('user_id', userId);

      if (products?.length > 0) {
        let reply = "Stock availability:\n\n";
        products.forEach(p => {
          const status = p.stock > 0 ? `${p.stock} units available` : "Out of stock";
          reply += `• ${p.name}: ${status}\n`;
        });
        return reply;
      }
    }

    return "Shukriya message karne ke liye! Koi aur sawaal ho toh batayein.";

  } catch (err) {
    console.error('getReply error:', err);
    return "Shukriya! Hum jald reply karenge.";
  }
}

async function sendMessage(to, message, phoneNumberId) {
  const pid = phoneNumberId || process.env.PHONE_NUMBER_ID;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${pid}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('WhatsApp error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
