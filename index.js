const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "convidesk123";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
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
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body.toLowerCase().trim();
      const reply = await getReply(from, text);
      await sendMessage(from, reply);
    }
  }
  res.sendStatus(200);
});

async function getReply(from, text) {
  try {
    const { data: firstBusiness } = await supabase
      .from('businesses')
      .select('user_id')
      .limit(1)
      .single();

    const userId = firstBusiness?.user_id;

    if (!userId) {
      return "Shukriya! Hum jald reply karenge.";
    }

    // Price query
    if (text.includes('price') || text.includes('rate') ||
        text.includes('kitna') || text.includes('cost') ||
        text.includes('kya hai') || text.includes('btao')) {

      const { data: products } = await supabase
        .from('products')
        .select('name, price, stock')
        .eq('user_id', userId);

      if (products && products.length > 0) {
        let reply = "Hamare products ki price list:\n\n";
        products.forEach(p => {
          reply += `• ${p.name}: ₹${p.price}\n`;
        });
        return reply;
      }
    }

    // Stock query
    if (text.includes('stock') || text.includes('available') ||
        text.includes('hai kya') || text.includes('milega')) {

      const { data: products } = await supabase
        .from('products')
        .select('name, stock')
        .eq('user_id', userId);

      if (products && products.length > 0) {
        let reply = "Stock availability:\n\n";
        products.forEach(p => {
          const status = p.stock > 0 ? `${p.stock} units available` : "Out of stock";
          reply += `• ${p.name}: ${status}\n`;
        });
        return reply;
      }
    }

    // Auto reply rules
    const { data: rules } = await supabase
      .from('auto_reply_rules')
      .select('*')
      .eq('user_id', userId);

    if (rules && rules.length > 0) {
      for (const rule of rules) {
        const keyword = rule.keyword?.toLowerCase();
        if (keyword && text.includes(keyword)) {
          return rule.reply;
        }
      }
    }

    return "Shukriya message karne ke liye! Koi aur sawaal ho toh batayein.";

  } catch (err) {
    console.error('Error:', err);
    return "Shukriya! Hum jald reply karenge.";
  }
}

async function sendMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
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
    console.error('WhatsApp send error:', err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
