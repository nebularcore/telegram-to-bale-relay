import JSZip from 'https://esm.sh/jszip@3.10.1';

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
      console.error("Critical Error:", err.message);
    }
    return new Response("OK");
  }
};

async function handleIncoming(message, env) {
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📤 ارسال عادی (بدون @)", callback_data: "mode_safe" }],
      [{ text: "🗜 ارسال به‌صورت Zip", callback_data: "mode_zip" }],
      [{ text: "❌ لغو عملیات", callback_data: "mode_cancel" }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text: "🛡 **پیام دریافت شد**\nلطفاً نحوه انتقال به بله را انتخاب کنید:\n(لینک‌ها و آیدی‌ها خودکار پاک می‌شوند)",
      reply_to_message_id: message.message_id,
      reply_markup: keyboard,
      parse_mode: "Markdown"
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
    await editTg(env, chatId, messageId, "❌ عملیات توسط کاربر لغو شد.");
    return;
  }

  await editTg(env, chatId, messageId, "⏳ در حال پردازش و ارسال به بله...");

  try {
    let rawText = originalMsg.text || originalMsg.caption || "";
    // حذف آیدی‌ها و لینک‌های تلگرام
    let safeText = rawText.replace(/@[a-zA-Z0-9_]+/g, "").replace(/(https?:\/\/)?t\.me\/[a-zA-Z0-9_]+/ig, "").trim();
    
    const file = getFileInfo(originalMsg);

    if (!file) {
      await sendToBale(env, "sendMessage", { text: safeText || "پیام متنی بدون محتوا" });
    } else {
      const tgFileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${file.id}`);
      const tgFileData = await tgFileRes.json();
      if (!tgFileData.ok) throw new Error("خطا در دریافت فایل از تلگرام");
      
      const fileUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;

      if (action === "mode_zip") {
        const fileBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const zip = new JSZip();
        const fileName = tgFileData.result.file_path.split('/').pop();
        zip.file(fileName, fileBuffer);
        const zipContent = await zip.generateAsync({ type: "blob" });
        await uploadToBale(env, zipContent, fileName + ".zip", safeText);
      } else {
        const method = file.type === "photo" ? "sendPhoto" : file.type === "video" ? "sendVideo" : "sendDocument";
        await sendToBale(env, method, { [file.type]: fileUrl, caption: safeText });
      }
    }
    await editTg(env, chatId, messageId, "✅ با موفقیت به بله منتقل شد.");
  } catch (e) {
    await editTg(env, chatId, messageId, `❌ خطا در انتقال: ${e.message}`);
  }
}

function getFileInfo(msg) {
  if (msg.photo) return { id: msg.photo.pop().file_id, type: 'photo' };
  if (msg.video) return { id: msg.video.file_id, type: 'video' };
  if (msg.document) return { id: msg.document.file_id, type: 'document' };
  if (msg.audio) return { id: msg.audio.file_id, type: 'audio' };
  return null;
}

async function editTg(env, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text })
  });
}

async function sendToBale(env, method, payload) {
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, chat_id: env.BALE_CHAT_ID })
  });
  return await res.json();
}

async function uploadToBale(env, blob, fileName, caption) {
  const formData = new FormData();
  formData.append("chat_id", env.BALE_CHAT_ID);
  formData.append("document", blob, fileName);
  if (caption) formData.append("caption", caption);
  const res = await fetch(`https://tapi.bale.ai/bot${env.BALE_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  return await res.json();
}
