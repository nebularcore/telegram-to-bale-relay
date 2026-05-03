/**
 * Telegram to Bale Relay Bot - Final Stable Version
 * Features: GitHub/Direct Link APK Bypass, Auto-Rename, Caption Sanitizer
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    try {
      const update = await request.json();
      
      if (update.message) {
        const msg = update.message;
        // امنیت: فقط پاسخ به آیدی مجاز
        if (String(msg.from.id) !== String(env.ALLOWED_USER_ID)) return new Response("OK");

        const hasFile = getFile(msg) !== null;
        const rawText = msg.text || msg.caption || "";
        // استخراج لینک از متن (حتی اگر بین کلمات دیگر باشد)
        const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);

        // سناریو 1: اگر پیام حاوی لینک مستقیم بود و فایل تلگرامی ضمیمه نداشت
        if (!hasFile && urlMatch) {
          await handleLink(urlMatch[0], msg, env);
        } 
        // سناریو 2: پردازش پیام‌های تلگرامی (فایل یا متن ساده)
        else {
          await handleIncoming(msg, env);
        }
      } 
      else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Worker Error:", err.message);
    }
    return new Response("OK");
  }
};

// --- 1. مدیریت لینک‌های مستقیم (مثل دانلود APK از Release گیت‌هاب) ---
async function handleLink(url, msg, env) {
  const chatId = msg.chat.id;
  const statusRes = await sendTg(env, "sendMessage", {
    chat_id: chatId,
    reply_to_message_id: msg.message_id,
    text: "🔗 لینک شناسایی شد. در حال بررسی و دانلود..."
  });
  const statusMsg = await statusRes.json();
  const statusId = statusMsg.result?.message_id;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`خطا در دسترسی به لینک (کد ${response.status})`);

    // بررسی حجم برای جلوگیری از کرش ورکر
    const size = response.headers.get("content-length");
    if (size && parseInt(size) > 50 * 1024 * 1024) {
      throw new Error("حجم فایل بالای 50 مگابایت است و بله آن را نمی‌پذیرد.");
    }

    if (statusId) await editTg(env, chatId, statusId, "⏳ در حال دانلود فایل از وب...");

    const blob = await response.blob();
    
    // تشخیص نام فایل
    let fileName = url.split('/').pop().split('?')[0] || "downloaded_file";
    
    // اگر فایل در لینک APK بود، نام را اصلاح می‌کنیم تا در مرحله آپلود تغییر پسوند داده شود
    if (url.toLowerCase().includes(".apk") && !fileName.toLowerCase().endsWith(".apk")) {
      fileName += ".apk";
    }

    if (!fileName.includes('.')) fileName += ".dat";

    const safeCaption = cleanText(msg.text || "") || "📥 دریافت شده از لینک مستقیم";
    
    if (statusId) await editTg(env, chatId, statusId, "📥 دانلود تمام شد. در حال آپلود به بله...");
    await uploadToBale(env, blob, fileName, safeCaption);

    if (statusId) await editTg(env, chatId, statusId, "✅ فایل با موفقیت به بله منتقل شد.");
  } catch (e) {
    if (statusId) await editTg(env, chatId, statusId, `❌ خطا: ${e.message}`);
  }
}

// --- 2. مدیریت ورودی‌های تلگرام و نمایش دکمه‌ها ---
async function handleIncoming(message, env) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی", callback_data: "mode_safe" }],
      [{ text: "🔒 پنهان‌سازی (Bypass APK)", callback_data: "mode_hide" }],
      [{ text: "❌ لغو", callback_data: "mode_cancel" }]
    ]
  };

  await sendTg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: "🛠 **آماده انتقال محتوا**\nلطفاً نوع عملیات را انتخاب کنید:",
    reply_to_message_id: message.message_id,
    reply_markup: keyboard
  });
}

// --- 3. مدیریت انتخاب کاربر (Callback) ---
async function handleCallback(cb, env) {
  if (String(cb.from.id) !== String(env.ALLOWED_USER_ID)) return;
  
  const action = cb.data;
  const originalMsg = cb.message.reply_to_message;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "mode_cancel") {
    await editTg(env, chatId, messageId, "❌ عملیات لغو شد.");
    return;
  }

  await editTg(env, chatId, messageId, "⏳ در حال آماده‌سازی و آپلود...");

  try {
    const file = getFile(originalMsg);
    const safeText = cleanText(originalMsg.text || originalMsg.caption || "");

    if (!file) {
      await sendToBale(env, "sendMessage", { text: safeText || "پیام متنی بدون محتوا" });
    } else {
      const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
      const tgFileData = await tgFileRes.json();

      if (!tgFileData.ok) throw new Error("فایل در تلگرام یافت نشد (احتمالاً بالای 20 مگابایت).");

      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;
      const fileName = tgFileData.result.file_path.split('/').pop();

      // دانلود برای تغییر پسوند یا ارسال مستقیم
      const fileRes = await fetch(fileUrl);
      const blob = await fileRes.blob();

      if (action === "mode_hide" || fileName.toLowerCase().endsWith(".apk")) {
        // تغییر پسوند برای دور زدن فیلتر بله
        let newName = fileName.endsWith(".apk") ? fileName.replace(/\.apk$/i, ".zip") : fileName + ".enc";
        await uploadToBale(env, blob, newName, safeText + "\n\n🔐 تغییر پسوند جهت عبور از فیلتر");
      } else {
        await uploadToBale(env, blob, fileName, safeText);
      }
    }
    await editTg(env, chatId, messageId, "✅ با موفقیت به بله منتقل شد.");
  } catch (e) {
    await editTg(env, chatId, messageId, `❌ خطا در انتقال:\n${e.message}`);
  }
}

// --- توابع کمکی (Helpers) ---

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/@[a-zA-Z0-9_]+/g, "") // حذف آیدی‌ها
    .replace(/(https?:\/\/)?(t\.me|telegram\.me)\/[^\s]+/ig, "") // حذف لینک‌های تلگرام
    .trim();
}

function getFile(m) {
  if (m.photo) return { id: m.photo.pop().file_id, type: 'photo' };
  if (m.video) return { id: m.video.file_id, type: 'video' };
  if (m.document) return { id: m.document.file_id, type: 'document' };
  if (m.audio) return { id: m.audio.file_id, type: 'audio' };
  return null;
}

async function uploadToBale(env, blob, name, cap) {
  const fd = new FormData();
  fd.append("chat_id", env.BALE_CHAT_ID);
  
  // لایه امنیتی نهایی: اگر به هر دلیلی هنوز پسوند .apk بود، آن را عوض کن
  let finalName = name;
  if (name.toLowerCase().endsWith(".apk")) {
    finalName = name.replace(/\.apk$/i, ".zip");
  }

  fd.append("document", blob, finalName);
  if (cap) fd.append("caption", cap.substring(0, 1024));
  
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { 
    method: "POST", 
    body: fd 
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "بله فایل را نپذیرفت.");
}

async function sendToBale(env, method, payload) {
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "ارسال به بله ناموفق بود.");
}

async function sendTg(env, method, payload) {
  return await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function editTg(env, cId, mId, txt) {
  await sendTg(env, "editMessageText", { chat_id: cId, message_id: mId, text: txt });
}
