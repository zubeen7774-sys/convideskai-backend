Yeh lo improved backend code:

```javascript
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ── Config ──
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "convidesk123";
const WA_TOKEN = process.env.WA_TOKEN;
const SYSTEM_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── In-memory dedup cache (resets on restart, use Redis for production) ──
const processedMessages = new Set();

// ── Logging helper ──
function log(level, msg, data = {}) {
  const timestamp = new Date().toISOString();
  console[level === 'error' ? 'error' : 'log'](
    JSON.stringify({ timestamp, level, msg, ...data })
  );
}

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'ConviDesk WhatsApp Bot',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── Webhook verification ──
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('info', 'Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  log('warn', 'Webhook verification failed', { mode, token });
  res.sendStatus(403);
});

// ── Webhook message handler ──
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately to Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    if (!entry) return;

    const message = entry.messages?.[0];
    if (!message) return;

    // Only handle text messages
    if (message.type !== 'text') return;

    const messageId = message.id;
    const from = message.from;
    const text = message.text.body.trim();
    const phoneNumberId = entry.metadata?.phone_number_id;

    // Dedup check
    if (processedMessages.has(messageId)) {
      log('info', 'Duplicate message skipped', { messageId });
      return;
    }
    processedMessages.add(messageId);

    // Clean up cache after 10 min
    setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

    log('info', 'Message received', { from, phoneNumberId, text: text.slice(0, 50) });

    // Get reply and send
    const reply = await getReply(from, text.toLowerCase(), phoneNumberId);
    await sendMessage(from, reply, phoneNumberId);

    // Save to contacts log
    await logIncomingMessage(from, text, phoneNumberId).catch(() => {});

  } catch (err) {
    log('error', 'Webhook processing error', { error: err.message });
  }
});

// ── Get user from phone_number_id ──
async function getUserId(phoneNumberId) {
  if (phoneNumberId) {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('user_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();

    if (data?.user_id) return data.user_id;
  }

  // Fallback to first business
  const { data } = await supabase
    .from('businesses')
    .select('user_id')
    .limit(1)
    .maybeSingle();

  return data?.user_id || null;
}

// ── Main reply logic ──
async function getReply(from, text, phoneNumberId) {
  try {
    const userId = await getUserId(phoneNumberId);

    if (!userId) {
      log('warn', 'No user found for phone_number_id', { phoneNumberId });
      return "Shukriya! Hum jald reply karenge.";
    }

    // ── Step 1: Knowledge Base ──
    const { data: knowledge } = await supabase
      .from('knowledge_base')
      .select('title, content')
      .eq('user_id', userId);

    if (knowledge?.length > 0) {
      for (const item of knowledge) {
        if (item.title && text.includes(item.title.toLowerCase())) {
          log('info', 'Knowledge base match', { title: item.title });
          return item.content;
        }
      }
    }

    // ── Step 2: Auto Reply Rules ──
    const { data: rules } = await supabase
      .from('auto_reply_rules')
      .select('keyword, reply')
      .eq('user_id', userId);

    if (rules?.length > 0) {
      for (const rule of rules) {
        const keyword = rule.keyword?.toLowerCase();
        if (keyword && text.includes(keyword)) {
          log('info', 'Auto reply rule matched', { keyword });
          return rule.reply;
        }
      }
    }

    // ── Step 3: Product Queries ──
    const isPriceQuery = /price|rate|kitna|cost|kya hai|btao|product|list|catalogue|catalog/.test(text);
    const isStockQuery = /stock|available|hai kya|milega|inventory/.test(text);

    if (isPriceQuery || isStockQuery) {
      const { data: products } = await supabase
        .from('products')
        .select('name, price, stock, category')
        .eq('user_id', userId);

      if (products?.length > 0) {
        if (isPriceQuery) {
          // Check if asking about specific product
          const specificProduct = products.find(p =>
            text.includes(p.name.toLowerCase())
          );

          if (specificProduct) {
            return `*${specificProduct.name}*\n💰 Price: ₹${specificProduct.price}\n📦 Stock: ${specificProduct.stock > 0 ? specificProduct.stock + ' units available' : 'Out of stock'}`;
          }

          // Group by category if available
          const byCategory = products.reduce((acc, p) => {
            const cat = p.category || 'Products';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(p);
            return acc;
          }, {});

          let reply = "📋 *Hamare Products Ki Price List:*\n\n";
          for (const [cat, items] of Object.entries(byCategory)) {
            if (Object.keys(byCategory).length > 1) {
              reply += `*${cat}*\n`;
            }
            items.forEach(p => {
              reply += `• ${p.name}: ₹${p.price}\n`;
            });
            reply += '\n';
          }
          reply += "_Koi specific product ke baare mein jaanna hai? Naam batao!_";
          return reply.trim();
        }

        if (isStockQuery) {
          let reply = "📦 *Stock Availability:*\n\n";
          products.forEach(p => {
            const status = p.stock > 0
              ? `✅ ${p.stock} units available`
              : "❌ Out of stock";
            reply += `• ${p.name}: ${status}\n`;
          });
          return reply.trim();
        }
      }
    }

    // ── Step 4: Common queries ──
    const greetings = /^(hi|hello|hey|helo|hii|namaste|namaskar|salaam|salam|assalam)/.test(text);
    if (greetings) {
      return "Namaste! 👋 Hamare store mein aapka swagat hai!\n\nMain aapki kya madad kar sakta hoon?\n• Price list ke liye likhein: *price*\n• Stock check ke liye: *stock*\n• Order ke liye: *order*";
    }

    const orderQuery = /order|book|kharidna|lena|chahiye/.test(text);
    if (orderQuery) {
      return "Order karne ke liye kripya batayein:\n\n1️⃣ Product ka naam\n2️⃣ Quantity\n3️⃣ Delivery address\n\nHum jald confirm karenge! ✅";
    }

    const locationQuery = /address|location|kahan|where|shop|store|office/.test(text);
    if (locationQuery) {
      const { data: business } = await supabase
        .from('businesses')
        .select('address, city')
        .eq('user_id', userId)
        .maybeSingle();

      if (business?.address) {
        return `📍 *Hamara Address:*\n${business.address}${business.city ? ', ' + business.city : ''}`;
      }
    }

    const timingQuery = /time|timing|open|close|hours|baje|kab/.test(text);
    if (timingQuery) {
      const { data: business } = await supabase
        .from('businesses')
        .select('business_hours')
        .eq('user_id', userId)
        .maybeSingle();

      if (business?.business_hours) {
        return `⏰ *Business Hours:*\n${business.business_hours}`;
      }
    }

    // ── Step 5: Fallback ──
    log('info', 'No match — sending fallback', { from, text: text.slice(0, 30) });
    return "Shukriya aapke message ke liye! 🙏\n\nHum jald reply karenge.\n\nYa in options mein se choose karein:\n• *price* — Products ki price list\n• *stock* — Stock availability\n• *order* — Order karna";

  } catch (err) {
    log('error', 'getReply error', { error: err.message });
    return "Shukriya! Hum jald reply karenge.";
  }
}

// ── Send WhatsApp message ──
async function sendMessage(to, message, phoneNumberId) {
  const pid = phoneNumberId || SYSTEM_PHONE_NUMBER_ID;

  if (!pid) {
    log('error', 'No phone_number_id available');
    return;
  }

  try {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${pid}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { 
          preview_url: false,
          body: message 
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    log('info', 'Message sent successfully', { 
      to, 
      messageId: response.data?.messages?.[0]?.id 
    });

  } catch (err) {
    const errorData = err.response?.data || err.message;
    log('error', 'WhatsApp send error', { to, error: errorData });
  }
}

// ── Log incoming message to contacts ──
async function logIncomingMessage(phone, text, phoneNumberId) {
  if (!phoneNumberId) return;

  const userId = await getUserId(phoneNumberId);
  if (!userId) return;

  // Upsert contact
  await supabase
    .from('contacts')
    .upsert({
      user_id: userId,
      phone,
      name: phone, // Will be updated when we get profile info
      last_message: text.slice(0, 100),
      last_seen: new Date().toISOString(),
    }, {
      onConflict: 'user_id,phone',
      ignoreDuplicates: false
    });
}

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});
```

---

## Kya Improve Hua

| Feature | Pehle | Ab |
|---------|-------|-----|
| Response timing | res baad mein | res.sendStatus(200) pehle |
| Multi-client | Sirf pehla business | phone_number_id se correct client |
| Dedup | Nahi tha | In-memory cache |
| Knowledge Base | Nahi tha | Step 1 mein check |
| Reply order | Rules → Products | KB → Rules → Products → Common → Fallback |
| Greetings | Nahi | Auto-detect |
| Order query | Nahi | Auto-detect |
| Location/Timing | Nahi | DB se fetch |
| Category grouping | Nahi | Products category wise |
| Specific product | Nahi | Name match karta hai |
| Logging | console.log | Structured JSON logs |
| API version | v18.0 | v21.0 |
| Error handling | Basic | Proper try-catch everywhere |
| Health check | Nahi | `/` endpoint |

---

**GitHub pe `index.js` replace karo → Railway auto-deploy karega.**
