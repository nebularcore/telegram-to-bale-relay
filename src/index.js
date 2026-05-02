export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    try {
      const update = await request.json();
      if (update.message) {
        await handleIncoming(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Worker Error:", err.message);
    }
    return new Response("OK");
  }
};

async function handleIncoming(message, env) {
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی (پاکسازی شده)", callback_data: "mode_safe" }],
      [{ text: "🔒 پنهان‌سازی (تغییر فرمت)", callback_data: "mode_hide" }],
      [{ text: "❌ لغو", callback_data: "mode_cancel" }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: "🛡 **مدیریت انتقال محتوا**\nنوع ارسال را انتخاب کنید. در هر دو حالت آیدی‌ها و لینک‌ها حذف می‌شوند.",
      reply_to_message_id: message.message_id,
      reply_markup: keyboard
    })
  });
}

async function handleCallback(cb, env) {
  if (String(cb.from.id) !== String(env.ALLOWED_USER_ID)) return;
  
  const action = cb.data;
  const originalMsg = cb.message.reply_to_message;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;

  if (action === "mode_cancel") {
    await editStatus(env, chatId, messageId, "❌ عملیات لغو شد.");
    return;
  }

  await editStatus(env, chatId, messageId, "⏳ در حال پردازش و ارسال...");

  try {
    let rawText = originalMsg.text || originalMsg.caption || "";
    // حذف دقیق آیدی‌ها و لینک‌های تلگرامی
    let safeText = rawText.replace(/@[a-zA-Z0-9_]+/g, "").replace(/(https?:\/\/)?t\.me\/[a-zA-Z0-9_]+/ig, "").trim();
    
    const file = getFile(originalMsg);

    if (!file) {
      await sendBale(env, "sendMessage", { text: safeText || "پیام بدون متن" });
    } else {
      const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
      const tgFileData = await tgFileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;

      if (action === "mode_hide") {
        // متد پنهان‌سازی بدون نیاز به کتابخانه زیپ
        const fileRes = await fetch(fileUrl);
        const blob = await fileRes.blob();
        const fakeName = `Secure_File_${Date.now()}.pdf.enc`; 
        await uploadBale(env, blob, fakeName, safeText + "\n\n🔐 محتوای تغییر فرمت یافته (امن)");
      } else {
        const method = file.type === "photo" ? "sendPhoto" : file.type === "video" ? "sendVideo" : "sendDocument";
        await sendToBale(env, method, { [file.type]: fileUrl, caption: safeText });
      }
    }
    await editStatus(env, chatId, messageId, "✅ با موفقیت به بله منتقل شد.");
  } catch (e) {
    await editStatus(env, chatId, messageId, `❌ خطا: ${e.message}`);
  }
}

function getFile(m) {
  if (m.photo) return { id: m.photo.pop().file_id, type: 'photo' };
  if (m.video) return { id: m.video.file_id, type: 'video' };
  if (m.document) return { id: m.document.file_id, type: 'document' };
  return null;
}

async function editStatus(env, cId, mId, txt) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cId, message_id: mId, text: txt })
  });
}

async function sendToBale(env, method, payload) {
  await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
}

async function uploadBale(env, blob, name, cap) {
  const fd = new FormData();
  fd.append("chat_id", env.BALE_CHAT_ID);
  fd.append("document", blob, name);
  fd.append("caption", cap);
  await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, { method: "POST", body: fd });
}
