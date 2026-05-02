export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // مسیر برای ثبت وبهوک
    if (url.pathname === "/set-webhook") {
      const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/setWebhook?url=${url.origin}`);
      return new Response(JSON.stringify(await tgRes.json()));
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message) {
          await handleUpdate(update.message, env);
        }
      } catch (e) {
        console.error(e);
      }
    }
    return new Response("OK");
  }
};

async function handleUpdate(message, env) {
  // امنیت: فقط اگر پیام از سمت شما بود پردازش شود
  if (String(message.from.id) !== String(env.ALLOWED_USER_ID)) return;

  const baleUrl = `https://tapi.bale.ai/bot${env.BALE_TOKEN}`;
  let method = "sendMessage";
  let payload = { chat_id: env.BALE_CHAT_ID };

  if (message.text) {
    payload.text = message.text;
  } else {
    // استخراج فایل
    const fileType = message.photo ? 'photo' : message.video ? 'video' : message.audio ? 'audio' : message.document ? 'document' : null;
    if (!fileType) return;

    const fileId = fileType === 'photo' ? message.photo.pop().file_id : message[fileType].file_id;
    
    // گرفتن لینک مستقیم فایل از تلگرام
    const tgFile = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${fileId}`);
    const tgFileData = await tgFile.json();

    if (tgFileData.ok) {
      const directUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${tgFileData.result.file_path}`;
      
      method = fileType === 'photo' ? 'sendPhoto' : fileType === 'video' ? 'sendVideo' : fileType === 'audio' ? 'sendAudio' : 'sendDocument';
      payload[fileType === 'photo' ? 'photo' : fileType === 'video' ? 'video' : fileType === 'audio' ? 'audio' : 'document'] = directUrl;
      payload.caption = message.caption || "";
    }
  }

  await fetch(`${baleUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
