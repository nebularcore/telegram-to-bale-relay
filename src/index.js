import JSZip from 'jszip';

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();
      
      // اگر پیام جدید بود
      if (update.message) {
        await handleIncomingMessage(update.message, env);
      } 
      // اگر روی دکمه‌های شیشه‌ای کلیک شد
      else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Error:", err.message);
    }
    return new Response("OK");
  }
};

// ==========================================
// 1. پردازش پیام ورودی و ارسال دکمه‌های شیشه‌ای
// ==========================================
async function handleIncomingMessage(message, env) {
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی (سانسور شده)", callback_data: "bale_normal" }],
      [{ text: "🔇 ارسال کاملاً بدون متن", callback_data: "bale_notext" }],
      [{ text: "🗜 تبدیل به فایل Zip و ارسال", callback_data: "bale_zip" }],
      [{ text: "❌ لغو عملیات", callback_data: "bale_cancel" }]
    ]
  };

  let textMsg = "✅ پیام دریافت شد.\n\n" +
                "🤖 لطفاً نحوه ارسال به بله را انتخاب کنید:\n\n" +
                "*(تمامی آیدی‌های @ و لینک‌های t.me به‌طور خودکار حذف می‌شوند)*\n\n" +
                "💡 **ترفند:** اگر می‌خواهید فایل زیپ شما رمز اختصاصی داشته باشد، هنگام ارسال فایل در کپشن بنویسید `#zip:رمز_شما`";

  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: textMsg,
      reply_to_message_id: message.message_id, // ریپلای روی فایل اصلی
      reply_markup: keyboard,
      parse_mode: "Markdown"
    })
  });
}

// ==========================================
// 2. پردازش کلیک روی دکمه‌ها
// ==========================================
async function handleCallback(cb, env) {
  if (String(cb.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const action = cb.data;
  const originalMsg = cb.message.reply_to_message; // پیام یا فایلی که دکمه روی آن ریپلای شده
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "bale_cancel") {
    await editTgMessage(env, chatId, messageId, "❌ عملیات ارسال لغو شد.");
    return;
  }

  await editTgMessage(env, chatId, messageId, "⏳ در حال آماده‌سازی، سانسور و ارسال به بله... (لطفاً صبور باشید)");

  try {
    // استخراج و سانسور متن
    let rawText = originalMsg.text || originalMsg.caption || "";
    let safeText = sanitizeText(rawText);
    
    // اگر کاربر دکمه بدون متن را زد
    if (action === "bale_notext") safeText = "";

    // استخراج رمز کاستوم از متن (مثال: #zip:1234)
    const zipMatch = rawText.match(/#zip:([^\s]+)/);
    const customZipPass = zipMatch ? zipMatch[1] : env.ZIP_PASSWORD;
    if (zipMatch) {
      safeText = safeText.replace(/#zip:[^\s]+/g, "").trim(); // پاک کردن هشتگ از کپشن نهایی
    }

    const fileInfo = getFileInfo(originalMsg);

    // اگر فقط یک متن ساده بود
    if (!fileInfo) {
      if (originalMsg.text) await sendToBale(env, "sendMessage", { text: safeText });
    } 
    // اگر فایل بود
    else {
      const fileUrl = await getTgFileUrl(env, fileInfo.id);

      if (action === "bale_zip" || zipMatch) {
        // --- عملیات زیپ کردن ---
        const fileBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const zip = new JSZip();
        
        // نام‌گذاری رندوم برای رد گم کنی
        const ext = fileUrl.split('.').pop();
        const randomName = "SecureFile_" + Math.floor(Math.random() * 10000) + "." + ext;
        
        zip.file(randomName, fileBuffer);
        const zipContent = await zip.generateAsync({ type: "blob" });

        let finalCaption = safeText ? safeText + "\n\n" : "";
        finalCaption += `🔒 فایل فشرده امن (Password: ${customZipPass || "بدون‌رمز"})`;

        await uploadToBale(env, zipContent, `Secured_${Date.now()}.zip`, finalCaption);
      } else {
        // --- عملیات ارسال مستقیم (لینک به لینک) ---
        const method = fileInfo.type === "photo" ? "sendPhoto" : fileInfo.type === "video" ? "sendVideo" : fileInfo.type === "audio" ? "sendAudio" : "sendDocument";
        const payload = { chat_id: env.BALE_CHAT_ID, [fileInfo.type]: fileUrl, caption: safeText };
        await sendToBale(env, method, payload);
      }
    }

    await editTgMessage(env, chatId, messageId, "✅ با موفقیت سانسور و به بله ارسال شد.");
  } catch (e) {
    await editTgMessage(env, chatId, messageId, `❌ خطا در ارسال عملیات:\n${e.message}`);
  }
}

// ==========================================
// توابع کمکی (Helper Functions)
// ==========================================

// تابع سانسور کردن آیدی‌ها و لینک‌های تلگرام
function sanitizeText(text) {
  if (!text) return "";
  let cleaned = text.replace(/@[a-zA-Z0-9_]+/g, ""); // حذف @username
  cleaned = cleaned.replace(/(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/[a-zA-Z0-9_]+/ig, ""); // حذف لینک کانال
  return cleaned.trim();
}

// تشخیص نوع فایل
function getFileInfo(msg) {
  if (msg.photo) return { id: msg.photo[msg.photo.length - 1].file_id, type: 'photo' };
  if (msg.video) return { id: msg.video.file_id, type: 'video' };
  if (msg.document) return { id: msg.document.file_id, type: 'document' };
  if (msg.audio) return { id: msg.audio.file_id, type: 'audio' };
  return null;
}

// گرفتن لینک مستقیم از تلگرام
async function getTgFileUrl(env, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${fileId}`);
  const json = await res.json();
  if (!json.ok) throw new Error("نمی‌توان فایل را از تلگرام خواند.");
  return `https://api.telegram.org/file/bot${env.TG_TOKEN}/${json.result.file_path}`;
}

// ویرایش پیام ربات در تلگرام
async function editTgMessage(env, chatId, messageId, newText) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: newText })
  });
}

// ارسال متد معمولی به بله
async function sendToBale(env, method, payload) {
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
  const result = await res.json();
  if (!result.ok) throw new Error(`Bale API Error: ${result.description}`);
}

// آپلود فایل زیپ به بله
async function uploadToBale(env, blob, fileName, caption) {
  const formData = new FormData();
  formData.append("chat_id", env.BALE_CHAT_ID);
  formData.append("document", blob, fileName);
  if (caption) formData.append("caption", caption);

  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  const result = await res.json();
  if (!result.ok) throw new Error(`Bale Upload Error: ${result.description}`);
}
