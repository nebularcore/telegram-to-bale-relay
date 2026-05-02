export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    try {
      const update = await request.json();
      if (update.message) {
        const msg = update.message;
        if (String(msg.from.id) !== String(env.ALLOWED_USER_ID)) return new Response("OK");

        const hasFile = getFile(msg) !== null;
        const rawText = msg.text || msg.caption || "";
        
        // پیدا کردن اولین لینک http/https در متن (در صورت وجود)
        const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);

        // اگر پیامی فقط شامل لینک باشد (یا فایلی ضمیمه نباشد)، لینک را دانلود می‌کنیم
        if (!hasFile && urlMatch) {
          await handleLink(urlMatch[0], msg, env);
        } else {
          await handleIncoming(msg, env);
        }
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Worker Error:", err.message);
    }
    // همیشه 200 برمی‌گردانیم تا تلگرام پیام را تکرار نکند
    return new Response("OK");
  }
};

// ==========================================
// 1. هندل کردن لینک‌های مستقیم (دانلود از وب)
// ==========================================
async function handleLink(url, msg, env) {
  const chatId = msg.chat.id;
  
  // ارسال پیام وضعیت اولیه
  const statusRes = await sendTg(env, "sendMessage", {
    chat_id: chatId,
    reply_to_message_id: msg.message_id,
    text: "🔗 لینک شناسایی شد. در حال بررسی..."
  });
  const statusMsg = await statusRes.json();
  const statusId = statusMsg.result?.message_id;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`سرور مبدا اجازه دانلود نداد (کد ${response.status}).`);

    // بررسی حجم فایل قبل از دانلود کامل (برای جلوگیری از کرش کلودفلر)
    const size = response.headers.get("content-length");
    if (size && parseInt(size) > 50 * 1024 * 1024) {
      throw new Error("حجم فایل بیش از ۵۰ مگابایت است (محدودیت حافظه کلودفلر).");
    }

    if (statusId) await editTg(env, chatId, statusId, "⏳ در حال دانلود و انتقال به بله...");

    const blob = await response.blob();

    // تلاش برای پیدا کردن نام واقعی فایل، اگر نبود یک نام پیش‌فرض می‌سازد
    let fileName = "downloaded_file";
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition && contentDisposition.includes("filename=")) {
      fileName = contentDisposition.split("filename=")[1].replace(/"/g, "");
    } else {
      fileName = url.split('/').pop().split('?')[0] || fileName;
      if (!fileName.includes('.')) fileName += ".dat"; 
    }

    // پاکسازی متن برای کپشن
    let rawText = msg.text || "";
    let safeText = cleanText(rawText);

    await uploadToBale(env, blob, fileName, safeText ? safeText : `📥 فایل دریافتی از لینک`);

    if (statusId) await editTg(env, chatId, statusId, "✅ فایل با موفقیت به بله ارسال شد.");
  } catch (e) {
    if (statusId) await editTg(env, chatId, statusId, `❌ خطا در پردازش لینک:\n${e.message}`);
  }
}

// ==========================================
// 2. هندل کردن پیام‌های تلگرامی (متن و فایل)
// ==========================================
async function handleIncoming(message, env) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی به بله", callback_data: "mode_safe" }],
      [{ text: "🔒 پنهان‌سازی (تغییر فرمت)", callback_data: "mode_hide" }],
      [{ text: "❌ لغو عملیات", callback_data: "mode_cancel" }]
    ]
  };

  await sendTg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: "🛡 **محتوا دریافت شد**\nلطفاً نوع انتقال را انتخاب کنید:\n(لینک‌ها و آیدی‌ها خودکار پاک می‌شوند)",
    reply_to_message_id: message.message_id,
    reply_markup: keyboard
  });
}

// ==========================================
// 3. هندل کردن کلیک روی دکمه‌های شیشه‌ای
// ==========================================
async function handleCallback(cb, env) {
  if (String(cb.from.id) !== String(env.ALLOWED_USER_ID)) return;
  
  const action = cb.data;
  const originalMsg = cb.message.reply_to_message;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "mode_cancel") {
    await editTg(env, chatId, messageId, "❌ عملیات توسط شما لغو شد.");
    return;
  }

  await editTg(env, chatId, messageId, "⏳ در حال پردازش...");

  try {
    let rawText = originalMsg.text || originalMsg.caption || "";
    let safeText = cleanText(rawText);
    
    const file = getFile(originalMsg);

    if (!file) {
      await sendToBale(env, "sendMessage", { text: safeText || "پیام متنی بدون محتوا" });
    } else {
      const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
      const tgFileData = await tgFileRes.json();

      if (!tgFileData.ok || !tgFileData.result.file_path) {
        throw new Error("حجم فایل بالای ۲۰ مگابایت است. (محدودیت API تلگرام)");
      }

      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;

      if (action === "mode_hide") {
        const fileRes = await fetch(fileUrl);
        const blob = await fileRes.blob();
        const fakeName = `Secure_${Date.now()}.pdf.enc`; 
        await uploadToBale(env, blob, fakeName, safeText + "\n\n🔐 محتوای تغییر فرمت یافته");
      } else {
        const method = file.type === "photo" ? "sendPhoto" : file.type === "video" ? "sendVideo" : "sendDocument";
        await sendToBale(env, method, { [file.type]: fileUrl, caption: safeText });
      }
    }
    await editTg(env, chatId, messageId, "✅ با موفقیت به بله منتقل شد.");
  } catch (e) {
    await editTg(env, chatId, messageId, `❌ خطا در انتقال:\n${e.message}`);
  }
}

// ==========================================
// توابع کمکی (Helper Functions)
// ==========================================

// تابع قدرتمند برای حذف آیدی‌ها و لینک‌های تلگرامی
function cleanText(text) {
  return text
    .replace(/@[a-zA-Z0-9_]+/g, "") // حذف آیدی ها (@)
    .replace(/(https?:\/\/)?(t\.me|telegram\.me)\/[^\s]+/ig, "") // حذف تمام لینک‌های تلگرامی
    .trim();
}

// استخراج اطلاعات فایل از پیام تلگرام
function getFile(m) {
  if (m.photo) return { id: m.photo.pop().file_id, type: 'photo' };
  if (m.video) return { id: m.video.file_id, type: 'video' };
  if (m.document) return { id: m.document.file_id, type: 'document' };
  if (m.audio) return { id: m.audio.file_id, type: 'audio' };
  return null;
}

// ارسال ریکوئست استاندارد به تلگرام
async function sendTg(env, method, payload) {
  return await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// ویرایش پیام در تلگرام
async function editTg(env, cId, mId, txt) {
  await sendTg(env, "editMessageText", { chat_id: cId, message_id: mId, text: txt });
}

// ارسال محتوا از طریق URL به بله
async function sendToBale(env, method, payload) {
  // جلوگیری از ارور محدودیت طول کپشن بله (بیشتر از 1024 کاراکتر مجاز نیست)
  if (payload.caption) payload.caption = payload.caption.substring(0, 1024);
  if (payload.text) payload.text = payload.text.substring(0, 4000);

  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "آپلود ناموفق بود.");
}

// آپلود فایل با دیتای خام (Blob) به بله
async function uploadToBale(env, blob, name, cap) {
  const fd = new FormData();
  fd.append("chat_id", env.BALE_CHAT_ID);
  fd.append("document", blob, name);
  if (cap) fd.append("caption", cap.substring(0, 1024)); // برش متن در صورت طولانی بودن
  
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { 
    method: "POST", 
    body: fd 
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "سرور بله فایل را نپذیرفت.");
                                }
